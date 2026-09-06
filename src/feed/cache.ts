import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { cacheConnection } from '../queue/connection.ts';
import { env } from '../config/env.ts';
// Type-only, therefore erased: this module has no runtime dependency on the debug
// sidecar, and the request path has none on the recommender types behind it.
import type { FeedDebugGeneration } from './debug.ts';

/**
 * Feed cache: immutable generations behind an active pointer.
 *
 * Key scheme
 * ----------
 *   feed:{userId}:epoch            integer, bumped on every state change
 *   feed:{userId}:active           feedId of the generation currently served
 *   feed:gen:{userId}:{feedId}     the generation itself, immutable once written
 *   feed:debug:{userId}:{feedId}   the demo-only explanation sidecar for it
 *
 * A generation is never mutated. Rebuilding writes a new feedId and flips the
 * pointer, which is what lets an already-issued cursor keep reading the exact list
 * it started on instead of silently shifting under the client mid-scroll.
 *
 * Generations outlive the pointer (2 x TTL) for the same reason: the pointer says
 * "what a new session gets", the generation says "what this session is reading".
 * That retention is derived from the existing TTL rather than being a new knob.
 */

const GENERATION_RETENTION_MULTIPLIER = 2;

/**
 * How many generations a user may hold at once: the current one and the one it
 * replaced.
 *
 * TTL alone bounds how *old* a generation can be, not how *many* exist. A user who
 * interacts twenty times in two hours would accumulate twenty live payloads, which
 * is what turns a tidy per-user memory estimate into a wrong one. Keeping the
 * previous generation is what lets a cursor survive exactly one refresh - enough
 * for a client mid-scroll when a rebuild lands, without unbounded retention.
 *
 * An operational constant rather than an environment variable: it is a property of
 * the caching strategy, not something an operator tunes per deployment.
 */
export const MAX_RETAINED_GENERATIONS_PER_USER = 2;

export interface FeedItem {
  videoId: string;
  rank: number;
  creatorId: string | null;
}

export interface FeedGeneration {
  feedId: string;
  userId: string;
  /** The epoch this feed was built for. Stale builds are discarded, not published. */
  epoch: number;
  generatedAt: string;
  expiresAt: string;
  coldStart: boolean;
  candidateShortage: boolean;
  diversityRelaxed: boolean;
  items: FeedItem[];
}

export class RedisUnavailableError extends Error {
  constructor(readonly reason: unknown) {
    super('Feed cache is unavailable');
    this.name = 'RedisUnavailableError';
  }
}

function client(): Redis {
  return cacheConnection();
}

export const feedKeys = {
  epoch: (userId: string) => `feed:${userId}:epoch`,
  active: (userId: string) => `feed:${userId}:active`,
  generation: (userId: string, feedId: string) => `feed:gen:${userId}:${feedId}`,
  /**
   * The demo explanation sidecar for one generation. Written with it, expired with
   * it, evicted with it - an explanation that outlived its ranking would describe a
   * feed nobody is being served.
   */
  debug: (userId: string, feedId: string) => `feed:debug:${userId}:${feedId}`,
  /** Newest-first list of this user's live generations, so trimming needs no SCAN. */
  index: (userId: string) => `feed:${userId}:generations`,
};

/** Any Redis failure on the request path becomes one typed error, never a fallback. */
async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RedisUnavailableError(error);
  }
}

export function newFeedId(): string {
  return randomUUID();
}

/**
 * The user's current epoch. Absent means 0 - a user who has never had a feed
 * invalidated is at the beginning, which is a valid state rather than an error.
 */
export async function currentEpoch(userId: string): Promise<number> {
  return guard(async () => {
    const raw = await client().get(feedKeys.epoch(userId));
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/**
 * Invalidates the user's feed and returns the new epoch.
 *
 * Both effects go in **one MULTI/EXEC**, and that is not a tidiness preference.
 * Sent as two independent commands, a connection drop between them leaves the
 * epoch advanced while the active pointer survives — so `/feed` keeps serving a
 * generation that predates the interaction, and the only thing that would clear it
 * is the TTL an hour later. Grouping them means the pair either both apply or
 * neither does, and no other client can observe the half-state in between.
 *
 * `INCR` remains atomic within that, so two concurrent interactions cannot land on
 * the same epoch and let one build overwrite the other.
 *
 * The queue write is deliberately **outside** this transaction. Redis MULTI cannot
 * span BullMQ's own multi-key job bookkeeping, and trying to make the two atomic
 * would mean a distributed transaction. The ordering is what makes that safe: the
 * feed is invalidated *first*, so a failed enqueue leaves a cache miss rather than
 * a stale feed. The next `GET /feed` sees no active pointer, answers 202 and queues
 * the build itself. The failure mode is a delayed rebuild, never a wrong feed.
 */
export async function invalidateFeed(userId: string): Promise<number> {
  return guard(async () => {
    const results = await client()
      .multi()
      .incr(feedKeys.epoch(userId))
      .del(feedKeys.active(userId))
      .exec();

    if (!results) {
      throw new Error('Feed invalidation transaction did not execute');
    }
    for (const [error] of results) {
      if (error) throw error;
    }

    const epoch = results[0]?.[1];
    if (typeof epoch !== 'number') {
      throw new Error(`Feed invalidation returned an unexpected epoch: ${String(epoch)}`);
    }
    return epoch;
  });
}

export async function readGeneration(
  userId: string,
  feedId: string,
): Promise<FeedGeneration | null> {
  return guard(async () => {
    const raw = await client().get(feedKeys.generation(userId, feedId));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as FeedGeneration;
    } catch {
      // A corrupt entry is treated as absent: rebuilding is always safe.
      return null;
    }
  });
}

/** The generation a new session should start on, or null when there is none. */
export async function readActiveGeneration(userId: string): Promise<FeedGeneration | null> {
  return guard(async () => {
    const feedId = await client().get(feedKeys.active(userId));
    if (feedId === null) return null;
    return readGeneration(userId, feedId);
  });
}

/**
 * Publishes a generation and evicts anything beyond the retention limit.
 *
 * The order is deliberate and not interchangeable:
 *
 *   1. write the payload      - so nothing can name a feed that does not exist
 *   2. write the debug sidecar, if one was built
 *   3. register it in the index
 *   4. flip the active pointer
 *   5. trim the index to the retention limit
 *   6. delete the payloads and sidecars that fell off
 *
 * Pointing at a feed before writing it would make every reader see a miss and
 * enqueue another build. Trimming before the pointer moves could delete the
 * generation a concurrent reader is about to be sent to. Because the new
 * generation is pushed to the head and eviction takes from the tail, the active
 * generation can never be the one trimmed - the invariant that matters most here.
 *
 * The sidecar is published here, through the same index and the same trim, rather
 * than by a second writer. Retention has exactly one implementation, so a sidecar
 * cannot outlive the generation it explains or survive as an orphan the index has
 * forgotten about.
 */
export async function publishGeneration(
  generation: FeedGeneration,
  debug?: FeedDebugGeneration,
): Promise<void> {
  return guard(async () => {
    const ttl = env.FEED_TTL_SECONDS;
    const retention = ttl * GENERATION_RETENTION_MULTIPLIER;
    const { userId, feedId } = generation;
    const redis = client();

    await redis.set(feedKeys.generation(userId, feedId), JSON.stringify(generation), 'EX', retention);

    if (debug) {
      await redis.set(feedKeys.debug(userId, feedId), JSON.stringify(debug), 'EX', retention);
    }

    await redis.lpush(feedKeys.index(userId), feedId);
    await redis.expire(feedKeys.index(userId), retention);

    await redis.set(feedKeys.active(userId), feedId, 'EX', ttl);

    // Everything past the retention window, read from the index rather than by
    // scanning the keyspace - KEYS/SCAN is O(n) over the whole database and has no
    // business anywhere near this path.
    const evicted = await redis.lrange(feedKeys.index(userId), MAX_RETAINED_GENERATIONS_PER_USER, -1);
    if (evicted.length > 0) {
      await redis.ltrim(feedKeys.index(userId), 0, MAX_RETAINED_GENERATIONS_PER_USER - 1);
      await redis.del(
        ...evicted.flatMap((id) => [feedKeys.generation(userId, id), feedKeys.debug(userId, id)]),
      );
    }
  });
}

/**
 * The explanation sidecar for one generation, or null when there is none.
 *
 * Null is an ordinary answer, not an error: a generation built before the sidecar
 * existed, or one whose sidecar write failed, still serves perfectly well as a feed.
 * The demo degrades to what `GET /feed` returned rather than reporting a fault.
 */
export async function readFeedDebug(
  userId: string,
  feedId: string,
): Promise<FeedDebugGeneration | null> {
  return guard(async () => {
    const raw = await client().get(feedKeys.debug(userId, feedId));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as FeedDebugGeneration;
    } catch {
      return null;
    }
  });
}

/** The user's live generations, newest first. Diagnostics and tests. */
export async function retainedGenerations(userId: string): Promise<string[]> {
  return guard(async () => client().lrange(feedKeys.index(userId), 0, -1));
}

/**
 * Test and demo helper: forgets everything cached for one user.
 *
 * Uses the index rather than a `KEYS feed:gen:{user}:*` glob, which would scan the
 * entire keyspace. Not on any request path, but the wrong habit to leave in a file
 * that is.
 */
export async function clearFeed(userId: string): Promise<void> {
  return guard(async () => {
    const redis = client();
    const feedIds = await redis.lrange(feedKeys.index(userId), 0, -1);
    await redis.del(
      feedKeys.active(userId),
      feedKeys.epoch(userId),
      feedKeys.index(userId),
      ...feedIds.flatMap((id) => [feedKeys.generation(userId, id), feedKeys.debug(userId, id)]),
    );
  });
}

export function generationTtlSeconds(): number {
  return env.FEED_TTL_SECONDS * GENERATION_RETENTION_MULTIPLIER;
}
