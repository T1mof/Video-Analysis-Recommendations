import { afterAll, describe, expect, it } from 'vitest';
import { cacheConnection, closeRedis, sharedConnection } from '../../src/queue/connection.ts';
import { closeFeedQueue, feedQueue } from '../../src/feed/queue.ts';
import { clearFeed, currentEpoch, newFeedId, publishGeneration } from '../../src/feed/cache.ts';

/**
 * Are the event listeners on the shared Redis connections transient or leaking?
 *
 * This exists because a "possible EventEmitter memory leak" warning was real: the
 * cache connection registered its error handler on every call rather than once with
 * the connection, so every cache operation leaked a listener. Raising the listener
 * ceiling had hidden it. The counts below stayed flat only after the registration
 * moved inside the memoisation.
 *
 * Peak during a burst is deliberately not asserted - a high count while a hundred
 * commands are in flight would be a normal shape. What must hold is that settled
 * counts return to baseline and do not drift wave on wave.
 */
const enabled = process.env.TEST_INTEGRATION === '1';

const EVENTS = ['error', 'end', 'close', 'ready', 'connect', 'drain'] as const;
const USER = '99999999-9999-4999-8999-999999999999';

function snapshot(): { cache: number; bullmq: number; detail: Record<string, number> } {
  const cache = cacheConnection();
  const shared = sharedConnection();
  const detail: Record<string, number> = {};
  let cacheTotal = 0;
  let bullmqTotal = 0;

  for (const event of EVENTS) {
    const c = cache.listenerCount(event);
    const b = shared.listenerCount(event);
    detail[`cache.${event}`] = c;
    detail[`bullmq.${event}`] = b;
    cacheTotal += c;
    bullmqTotal += b;
  }
  return { cache: cacheTotal, bullmq: bullmqTotal, detail };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

afterAll(async () => {
  if (!enabled) return;
  await clearFeed(USER).catch(() => {});
  await closeFeedQueue();
  await closeRedis();
});

describe.skipIf(!enabled)('Redis listener hygiene', () => {
  it('returns to baseline after repeated waves of cache operations', async () => {
    const cache = cacheConnection();
    await cache.ping();
    await feedQueue().waitUntilReady();
    await settle();

    const baseline = snapshot();
    const settled: number[] = [];

    for (let wave = 0; wave < 4; wave++) {
      // Sequential, then a burst - the shape that produced the warning.
      for (let i = 0; i < 20; i++) await cache.get(`listener-probe:seq:${i}`);
      await Promise.all(
        Array.from({ length: 100 }, (_, i) => cache.get(`listener-probe:burst:${i}`)),
      );
      await settle();
      settled.push(snapshot().cache);
    }

    // Every settled wave is back where it started - no accumulation.
    for (const [index, count] of settled.entries()) {
      expect(count, `cache listeners after wave ${index + 1}`).toBe(baseline.cache);
    }
    // And no upward drift between the first and last settled wave.
    expect(settled.at(-1)!).toBe(settled[0]!);
  }, 60_000);

  it('returns to baseline after repeated waves of feed and queue operations', async () => {
    await feedQueue().waitUntilReady();
    await settle();
    const baseline = snapshot();
    const settled: { cache: number; bullmq: number }[] = [];

    for (let wave = 0; wave < 4; wave++) {
      await Promise.all(
        Array.from({ length: 25 }, async () => {
          await currentEpoch(USER);
          await publishGeneration({
            feedId: newFeedId(),
            userId: USER,
            epoch: 0,
            generatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            coldStart: false,
            candidateShortage: false,
            diversityRelaxed: false,
            items: [],
          });
        }),
      );
      await feedQueue().getJobs(['waiting', 'delayed']);
      await settle();
      const now = snapshot();
      settled.push({ cache: now.cache, bullmq: now.bullmq });
    }

    for (const [index, counts] of settled.entries()) {
      expect(counts.cache, `cache listeners after wave ${index + 1}`).toBe(baseline.cache);
      expect(counts.bullmq, `bullmq listeners after wave ${index + 1}`).toBe(baseline.bullmq);
    }

    // The invariant that distinguishes a burst from a leak.
    expect(settled.at(-1)!.cache).toBe(settled[0]!.cache);
    expect(settled.at(-1)!.bullmq).toBe(settled[0]!.bullmq);
  }, 60_000);
});
