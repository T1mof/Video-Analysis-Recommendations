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

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
}
