import { env } from '../config/env.ts';
import {
  type FeedGeneration,
  type FeedItem,
  currentEpoch,
  readActiveGeneration,
  readGeneration,
} from './cache.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { enqueueFeedBuild, refillDeduplicationId } from './queue.ts';

/**
 * Request-path orchestration.
 *
 * This module reads Redis and nothing else. It does not import the recommender,
 * the database or pgvector - not as a fallback, not behind a flag, not with a
 * timeout. That is enforced by what it imports rather than by discipline, because
 * a synchronous fallback is exactly the thing that quietly reintroduces a
 * database query into a 3k RPS hot path the first time someone debugs a cache miss.
 */

export type FeedStatus = 'ready' | 'building';

export interface FeedPage {
  status: FeedStatus;
  feedId?: string;
  generatedAt?: string;
  coldStart?: boolean;
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Present when the feed is being built; a hint for the client, not a promise. */
  retryAfterMs?: number;
  /** Diagnostics: a next generation was queued because this one is nearly spent. */
  refillQueued?: boolean;
}

export class FeedGoneError extends Error {
  readonly code = 'feed_expired';
  constructor() {
    super('The feed this cursor belongs to has expired');
    this.name = 'FeedGoneError';
  }
}

const BUILD_RETRY_AFTER_MS = 500;

export interface GetFeedOptions {
  userId: string;
  limit: number;
  cursor?: string;
}

/**
 * Serves a page of the user's feed.
 *
 * A cursor pins the session to one immutable generation; without one the user
 * starts on whatever is currently active. A miss enqueues a build and answers
 * "building" rather than computing anything inline.
 */
export async function getFeedPage(options: GetFeedOptions): Promise<FeedPage> {
  const { userId, limit } = options;

  if (options.cursor) {
    // Throws InvalidCursorError for anything malformed or belonging to another
    // user - checked before a single Redis key is addressed.
    const cursor = decodeCursor(options.cursor, userId);
    const generation = await readGeneration(userId, cursor.feedId);
    if (!generation) {
      // The generation aged out mid-session. Distinct from "no feed yet": the
      // client should start a new session rather than retry the same cursor.
      throw new FeedGoneError();
    }
    return withRefill(generation, cursor.offset, limit);
  }

  const active = await readActiveGeneration(userId);
  if (!active) {
    const epoch = await currentEpoch(userId);
    await enqueueFeedBuild({ userId, epoch, reason: 'miss' });
    return {
      status: 'building',
      items: [],
      nextCursor: null,
      hasMore: false,
      retryAfterMs: BUILD_RETRY_AFTER_MS,
    };
  }

  return withRefill(active, 0, limit);
}

/**
 * Serves the page, then decides whether to queue the next generation.
 *
 * The refill never affects what this request returns - the current generation is
 * served either way. Queuing ahead of the client is the only way a background
 * build can be ready before the list runs out.
 */
async function withRefill(
  generation: FeedGeneration,
  offset: number,
  limit: number,
): Promise<FeedPage> {
  const result = page(generation, offset, limit);
  const remaining = remainingAfter(generation, offset, result.items.length);
  const refillQueued = await maybeRefill(generation, remaining);
  return refillQueued ? { ...result, refillQueued } : result;
}

function page(generation: FeedGeneration, offset: number, limit: number): FeedPage {
  const slice = generation.items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < generation.items.length;

  return {
    status: 'ready',
    feedId: generation.feedId,
    generatedAt: generation.generatedAt,
    coldStart: generation.coldStart,
    items: slice,
    nextCursor: hasMore
      ? encodeCursor({ userId: generation.userId, feedId: generation.feedId, offset: nextOffset })
      : null,
    hasMore,
  };
}

/**
 * Queues the next generation when the client is close to exhausting this one.
 *
 * Two guards keep this from becoming a treadmill. It is deduplicated per
 * generation, so paging through the tail queues one refill rather than one per
 * request. And it is skipped when the generation already reported a candidate
 * shortage: rebuilding cannot invent videos that do not exist, so on a small or
 * fully-seen corpus a refill would rebuild the same short list forever.
 *
 * Returns whether a refill was requested - the caller does not wait for it, and
 * this page is always served from the current generation regardless.
 */
export async function maybeRefill(generation: FeedGeneration, remaining: number): Promise<boolean> {
  if (remaining > env.FEED_REFILL_WATERMARK) return false;
  if (generation.candidateShortage) return false;
  // An empty generation has no tail to approach. Without this it would satisfy the
  // watermark trivially and queue one build per read, forever.
  if (generation.items.length === 0) return false;

  const epoch = await currentEpoch(generation.userId);
  await enqueueFeedBuild(
    { userId: generation.userId, epoch, reason: 'refill' },
    refillDeduplicationId(generation.userId, generation.feedId),
  );
  return true;
}

/** How many items remain after the page that was just served. */
export function remainingAfter(generation: FeedGeneration, offset: number, served: number): number {
  return Math.max(0, generation.items.length - (offset + served));
}

export { decodeCursor, encodeCursor };
