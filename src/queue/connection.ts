import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its connection - it manages
 * retries itself and a client-side retry limit makes blocking commands fail.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

let shared: Redis | undefined;

/** Lazily created connection shared by queues within one process. */
export function sharedConnection(): Redis {
  shared ??= createRedisConnection();
  return shared;
}

let cache: Redis | undefined;

/**
 * Connection for cache reads on the request path - deliberately NOT the BullMQ one.
 *
 * BullMQ needs `maxRetriesPerRequest: null`, which makes a command retry forever
 * while Redis is down. That is right for a background job and wrong for an HTTP
 * handler: `GET /feed` would hang instead of returning a controlled 503. This one
 * fails fast so the API can answer honestly that the cache is unavailable.
 */
export function cacheConnection(): Redis {
  if (!cache) {
    cache = new Redis(env.REDIS_URL, {
      // Fail fast, but bounded by time rather than by refusing to queue: with the
      // offline queue disabled, commands issued during the initial handshake are
      // rejected outright, so the first request after a deploy would answer 503
      // against a perfectly healthy Redis. These two settings give the same
      // fast-failure behaviour when Redis is genuinely down, without that false
      // negative on startup.
      maxRetriesPerRequest: 2,
      connectTimeout: 1_000,
      commandTimeout: 1_500,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });

    // Registered once, with the connection. Attaching it on every call - outside
    // this block - adds a listener per call site invocation and leaks one for every
    // cache operation the process performs. That is what the earlier
    // "possible EventEmitter memory leak" warning was actually reporting, and
    // raising the listener ceiling would have hidden it rather than fixed it.
    cache.on('error', () => {
      // Errors surface at the call site as a rejected command; an unhandled
      // 'error' event would crash the process instead.
    });
  }
  return cache;
}

export async function closeRedis(): Promise<void> {
  const clients = [shared, cache].filter((client): client is Redis => client !== undefined);
  shared = undefined;
  cache = undefined;
  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }),
  );
}
