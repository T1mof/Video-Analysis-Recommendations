import { Queue } from 'bullmq';
import { sharedConnection } from '../queue/connection.ts';

/**
 * Feed build queue.
 *
 * Deduplication uses BullMQ's own mechanism rather than a hand-rolled lock. The key
 * is `user + epoch`, so a hundred simultaneous cache misses for one user collapse
 * into one logical build, while a genuine state change (which bumps the epoch)
 * always gets its own.
 *
 * `keepLastIfActive` is what makes that safe under load: with it, at most one job
 * per key is active and at most one waiting, so a build cannot run twice in
 * parallel for the same user. Verified against the installed BullMQ (6.3.x), which
 * documents this option explicitly - dedupe by `jobId` would have been wrong here,
 * because it stops deduplicating as soon as the completed job is evicted.
 */

export const QUEUE_FEED = 'feed';

export interface FeedJob {
  userId: string;
  /** The epoch this build is for. A build for a stale epoch is discarded. */
  epoch: number;
  /** Why the build was requested - diagnostics only. */
  reason: 'miss' | 'invalidation' | 'refill' | 'prewarm';
}

let queue: Queue<FeedJob> | undefined;

export function feedQueue(): Queue<FeedJob> {
  queue ??= new Queue<FeedJob>(QUEUE_FEED, {
    connection: sharedConnection(),
    defaultJobOptions: {
      // Bounded: a build that keeps failing must not retry forever, and completed
      // jobs must not accumulate in Redis until it runs out of memory.
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });
  return queue;
}

/** One logical build per user and epoch. */
export function buildDeduplicationId(userId: string, epoch: number): string {
  return `feed:${userId}:${epoch}`;
}

/** One refill per generation, so repeated tail reads do not queue repeatedly. */
export function refillDeduplicationId(userId: string, feedId: string): string {
  return `refill:${userId}:${feedId}`;
}

export interface EnqueueResult {
  enqueued: boolean;
  deduplicationId: string;
}

/**
 * Requests a feed build. Safe to call on every cache miss: duplicates collapse.
 *
 * Failures are the caller's to interpret. For `POST /interactions` the interaction
 * is already durable in Postgres and a failed enqueue must not undo it.
 */
export async function enqueueFeedBuild(
  job: FeedJob,
  deduplicationId = buildDeduplicationId(job.userId, job.epoch),
): Promise<EnqueueResult> {
  await feedQueue().add('build', job, {
    deduplication: { id: deduplicationId, keepLastIfActive: true },
  });
  return { enqueued: true, deduplicationId };
}

export async function closeFeedQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
