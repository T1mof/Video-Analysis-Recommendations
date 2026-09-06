import { Worker } from 'bullmq';
import { sharedConnection } from '../queue/connection.ts';
import { env } from '../config/env.ts';
import { recommendCandidates } from '../reco/recommender.ts';
import {
  type FeedGeneration,
  currentEpoch,
  newFeedId,
  generationTtlSeconds,
  publishGeneration,
  readActiveGeneration,
} from './cache.ts';
import { projectFeedDebug } from './debug.ts';
import { QUEUE_FEED, type FeedJob } from './queue.ts';

/**
 * Feed builder.
 *
 * The only place that calls the recommender. Everything on the request path reads
 * Redis and nothing else - that separation is the whole point of the design, and
 * keeping the M6 call in a worker process is what enforces it structurally rather
 * than by convention.
 */

export interface BuildOutcome {
  published: boolean;
  /** The build completed but a newer epoch had already superseded it. */
  stale?: boolean;
  /**
   * A valid generation for this exact epoch already existed, so the job was already
   * satisfied and no ranking was run. Distinct from `stale`: nothing was superseded,
   * the work had simply already been done.
   */
  alreadyBuilt?: boolean;
  feedId?: string;
  items?: number;
}

export interface BuildOptions {
  /**
   * Write the demo explanation sidecar alongside the generation.
   *
   * Defaults to `FEED_DEBUG_SIDECAR` (off). Explicit here so tests state what they
   * are exercising instead of depending on ambient configuration.
   */
  withDebugSidecar?: boolean;
}

/**
 * Which jobs an existing same-epoch generation already satisfies.
 *
 * `miss` and `invalidation` both mean "this user currently has no feed". If one now
 * exists *for the same epoch*, nothing about the user's state has changed since the
 * job was queued and rebuilding would produce an identical list - so the job is done.
 *
 * `refill` and `prewarm` are the opposite case: they deliberately ask for a new
 * generation *while* a valid one is active, which is their entire purpose. Skipping
 * them would silently disable refill, so the distinction is by intent rather than by
 * a blanket rule.
 */
function satisfiedByActiveGeneration(reason: FeedJob['reason']): boolean {
  return reason === 'miss' || reason === 'invalidation';
}

/** The feedId that already satisfies this job, or null if none does. */
async function alreadySatisfiedBy(job: FeedJob): Promise<string | null> {
  if (!satisfiedByActiveGeneration(job.reason)) return null;
  const active = await readActiveGeneration(job.userId);
  // The generation's `epoch` is the epoch it was *built for*. Comparing against it -
  // rather than recording a permanent "highest epoch ever built" marker - is what
  // keeps a legitimate rebuild possible once the pointer expires: no active
  // generation means no answer to compare with, so the build goes ahead.
  return active && active.epoch === job.epoch ? active.feedId : null;
}

/**
 * Builds one feed and publishes it, unless the work is stale or already done.
 *
 * Two distinct races are guarded here, and they need different answers.
 *
 * **Superseded epoch.** A slow build must not overwrite a fresher feed:
 *
 *   job A starts (epoch 1) → user interacts (epoch 2) → job B builds and finishes
 *   → job A finishes last and would overwrite a fresh feed with a stale one
 *
 * The epoch is re-read immediately before publishing and a stale result is discarded.
 * That is a normal outcome, not a failure - the newer job already published something
 * better.
 *
 * **Duplicate build for one unchanged state.** A preference-changing interaction
 * queues a build at epoch E; the client's next `GET` finds the pointer already dropped
 * and queues another at the *same* E. BullMQ's deduplication only holds while the
 * first job is in its lifecycle, so once that job completes the second is admitted -
 * and the epoch guard lets it through, because it rejects *older* epochs, not equal
 * ones. The result was two publications for one unchanged user state, the second of
 * which evicted the generation the user was still reading.
 *
 * Checking for an existing same-epoch generation closes it, before the expensive
 * ranking call and again immediately before publishing. This is **not** the same
 * problem as interaction coalescing: coalescing is about `view → complete → like`
 * producing three *different* epochs, which is a tuning question. This is two builds
 * for one epoch, which is simply redundant work.
 */
export async function buildFeed(job: FeedJob, options: BuildOptions = {}): Promise<BuildOutcome> {
  const withDebugSidecar = options.withDebugSidecar ?? env.FEED_DEBUG_SIDECAR;

  // Cheap checks first. Both can rule out the whole build for two Redis reads, and
  // the point of the exercise is not paying for a ranking pass nobody needs.
  if ((await currentEpoch(job.userId)) !== job.epoch) {
    return { published: false, stale: true };
  }
  const satisfiedBefore = await alreadySatisfiedBy(job);
  if (satisfiedBefore) {
    return { published: false, alreadyBuilt: true, feedId: satisfiedBefore };
  }

  const result = await recommendCandidates(job.userId, env.FEED_SIZE);

  // Re-checked after the build, because it took time and the world may have moved:
  // the user may have interacted again (stale), or a concurrent job may have
  // published for this same epoch (alreadyBuilt).
  if ((await currentEpoch(job.userId)) !== job.epoch) {
    return { published: false, stale: true };
  }
  const satisfiedAfter = await alreadySatisfiedBy(job);
  if (satisfiedAfter) {
    return { published: false, alreadyBuilt: true, feedId: satisfiedAfter };
  }

  const now = new Date();
  const generation: FeedGeneration = {
    feedId: newFeedId(),
    userId: job.userId,
    epoch: job.epoch,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + generationTtlSeconds() * 1000).toISOString(),
    coldStart: result.diagnostics.coldStart,
    candidateShortage: result.diagnostics.candidateShortage,
    diversityRelaxed: result.diagnostics.diversityRelaxed,
    // Deliberately compact: ids and rank, not vectors or score breakdowns. Those
    // live in Postgres and in the recommender's diagnostics; a cache exists to be
    // read fast, and 110 floats per item would multiply its footprint for nothing.
    items: result.items.map((item, index) => ({
      videoId: item.videoId,
      rank: index + 1,
      creatorId: result.videos.get(item.videoId)?.creatorId ?? null,
    })),
  };

  // Off by default. When on, the explanation is *projected* from the result already
  // in hand - every number the demo shows came from this one ranking pass - and is
  // published with the generation so the two share a lifetime. It costs roughly 17x
  // the generation payload per item, which is a demo cost and not one a production
  // deployment should pay. See feed/debug.ts.
  const debug = withDebugSidecar ? projectFeedDebug(generation, result) : undefined;

  // An empty feed is a real answer, not a failure: it is published like any other
  // so that repeated requests are served from cache instead of queueing forever.
  await publishGeneration(generation, debug);
  return { published: true, feedId: generation.feedId, items: generation.items.length };
}

export function startFeedWorker(): Worker<FeedJob> {
  const worker = new Worker<FeedJob>(QUEUE_FEED, async (job) => buildFeed(job.data), {
    connection: sharedConnection(),
    concurrency: env.FEED_CONCURRENCY,
  });

  worker.on('failed', (job, error) => {
    console.error(`feed build failed for ${job?.data.userId ?? 'unknown'}: ${error.message}`);
  });

  return worker;
}
