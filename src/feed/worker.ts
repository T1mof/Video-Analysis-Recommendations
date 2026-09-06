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
} from './cache.ts';
import { QUEUE_FEED, type FeedJob } from './queue.ts';

/**
 * Feed builder.
 *
 * The only place in M7 that calls the recommender. Everything on the request path
 * reads Redis and nothing else - that separation is the whole point of the design,
 * and keeping the M6 call in a worker process is what enforces it structurally
 * rather than by convention.
 */

export interface BuildOutcome {
  published: boolean;
  /** Set when the build completed but a newer epoch had already superseded it. */
  stale?: boolean;
  feedId?: string;
  items?: number;
}

/**
 * Builds one feed and publishes it, unless the world moved on while it ran.
 *
 * The race this prevents:
 *
 *   job A starts (epoch 1) → user interacts (epoch 2) → job B starts and finishes
 *   → job A finishes last and overwrites a fresh feed with a stale one
 *
 * Re-reading the epoch immediately before publishing closes it. A stale result is
 * discarded, which is a normal outcome and not a failure - the newer job already
 * published something better.
 */
export async function buildFeed(job: FeedJob): Promise<BuildOutcome> {
  const result = await recommendCandidates(job.userId, env.FEED_SIZE);

  const epochNow = await currentEpoch(job.userId);
  if (epochNow !== job.epoch) {
    return { published: false, stale: true };
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

  // An empty feed is a real answer, not a failure: it is published like any other
  // so that repeated requests are served from cache instead of queueing forever.
  await publishGeneration(generation);
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
