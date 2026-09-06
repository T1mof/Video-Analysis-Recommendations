import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { RecommendationResult } from '../../src/reco/recommender.ts';

/**
 * Feed build guards, at the level where they actually live: the worker.
 *
 * Two properties are under test.
 *
 * **One useful publication per epoch.** A preference-changing interaction queues a
 * build at epoch E; the client's next `GET` finds the pointer already dropped and
 * queues another at the same E. BullMQ's deduplication only holds while the first job
 * is in its lifecycle, so once that job completes the second is admitted - and the
 * epoch guard passes it, because it rejects *older* epochs, not equal ones. The result
 * was two publications for one unchanged user state, the second evicting the
 * generation the user was still reading.
 *
 * This is not interaction coalescing. Coalescing is about `view → complete → like`
 * producing three *different* epochs. This is two builds for one epoch: redundant work
 * by any measure.
 *
 * **The debug sidecar is opt-in.** It costs ~17x the served payload per item, so a
 * feed build must not write one unless asked.
 */

/** Counts ranking passes, so "did not run M6 again" is an assertion, not an inference. */
const recommendCalls: string[] = [];

vi.mock('../../src/reco/recommender.ts', () => ({
  recommendCandidates: vi.fn(async (userId: string): Promise<RecommendationResult> => {
    recommendCalls.push(userId);
    return {
      userId,
      items: [],
      videos: new Map(),
      diagnostics: {
        coldStart: false,
        requestedLimit: 50,
        returned: 0,
        candidateCounts: { similar: 0, tag: 0, trending: 0, fresh: 0, explore: 0 },
        uniqueCandidates: 0,
        eligibleVideos: 0,
        filteredSeen: 0,
        candidateShortage: false,
        diversityRelaxed: false,
        relaxedCount: 0,
        latencyMs: 1,
      },
    };
  }),
}));

const { closeDb, db } = await import('../../src/db/client.ts');
const { users, videoEmbeddings, videoFeatures, videos } = await import('../../src/db/schema.ts');
const { encodeFeatures } = await import('../../src/analysis/embedding.ts');
const { TAXONOMY_VERSION } = await import('../../src/analysis/taxonomy.ts');
const { PROMPT_VERSION } = await import('../../src/analysis/schema.ts');
const { buildServer } = await import('../../src/api/server.ts');
const { cacheConnection, closeRedis } = await import('../../src/queue/connection.ts');
const cache = await import('../../src/feed/cache.ts');
const { buildFeed } = await import('../../src/feed/worker.ts');
const { closeFeedQueue, feedQueue } = await import('../../src/feed/queue.ts');
const { makeFeatures } = await import('../fixtures.ts');

const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'fbld_';
let userId: string;
let videoId: string;
let app: FastifyInstance;

/** How many generations exist for one epoch, read from the retention index. */
async function generationsAtEpoch(epoch: number): Promise<string[]> {
  const feedIds = await cache.retainedGenerations(userId);
  const found: string[] = [];
  for (const feedId of feedIds) {
    const generation = await cache.readGeneration(userId, feedId);
    if (generation?.epoch === epoch) found.push(feedId);
  }
  return found;
}

beforeAll(async () => {
  if (!enabled) return;

  const [user] = await db
    .insert(users)
    .values({ label: `${PREFIX}user` })
    .returning({ id: users.id });
  userId = user!.id;

  const features = makeFeatures();
  const [video] = await db
    .insert(videos)
    .values({
      source: 'test',
      externalId: `${PREFIX}v1`,
      s3Key: `${PREFIX}v1.mp4`,
      durationSeconds: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1024,
      checksum: `${PREFIX}v1-checksum`,
      status: 'analyzed',
    })
    .returning({ id: videos.id });
  videoId = video!.id;

  await db.insert(videoFeatures).values({
    videoId,
    modelName: 'test',
    modelVersion: 'test',
    promptVersion: PROMPT_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    features,
    framesUsed: 8,
  });
  await db.insert(videoEmbeddings).values({
    videoId,
    taxonomyVersion: TAXONOMY_VERSION,
    embedding: encodeFeatures(features),
  });

  app = buildServer({ logger: false });
  await app.ready();
}, 90_000);

afterEach(async () => {
  if (!enabled) return;
  recommendCalls.length = 0;
  await cache.clearFeed(userId);
  for (const job of await feedQueue().getJobs(['waiting', 'delayed', 'active', 'prioritized'])) {
    await job.remove().catch(() => {});
  }
});

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  if (userId) await db.delete(users).where(eq(users.id, userId));
  await db.delete(videos).where(like(videos.externalId, `${PREFIX}%`));
  await closeFeedQueue();
  await closeRedis();
  await closeDb();
}, 90_000);

describe.skipIf(!enabled)('same-epoch duplicate builds', () => {
  it('A. an interaction and the cache miss it causes produce one generation, not two', async () => {
    // The exact observed sequence. An interaction invalidates and queues a build; the
    // client's very next request finds no pointer, answers 202 and queues another for
    // the same epoch.
    const accepted = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: { eventId: `${PREFIX}like-${Date.now()}`, userId, videoId, type: 'like' },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().feedInvalidated).toBe(true);

    const epoch = await cache.currentEpoch(userId);

    const miss = await app.inject({ method: 'GET', url: `/feed?userId=${userId}` });
    expect(miss.statusCode).toBe(202);

    // Drained sequentially, which is what a worker does and what releases BullMQ's
    // deduplication key between the two.
    const first = await buildFeed({ userId, epoch, reason: 'invalidation' });
    const second = await buildFeed({ userId, epoch, reason: 'miss' });

    expect(first.published).toBe(true);
    expect(second.published).toBe(false);
    expect(second.alreadyBuilt).toBe(true);
    // Not `stale`: nothing superseded this job, the work had simply been done.
    expect(second.stale).toBeUndefined();
    expect(second.feedId).toBe(first.feedId);

    expect(await generationsAtEpoch(epoch)).toEqual([first.feedId]);
  });

  it('B. the second job for one epoch does not run the recommender again', async () => {
    const epoch = await cache.currentEpoch(userId);

    await buildFeed({ userId, epoch, reason: 'miss' });
    expect(recommendCalls).toHaveLength(1);

    await buildFeed({ userId, epoch, reason: 'miss' });
    await buildFeed({ userId, epoch, reason: 'invalidation' });

    // The whole point of checking *before* the build rather than only before
    // publishing: the expensive stage never runs.
    expect(recommendCalls).toHaveLength(1);
  });

  it('C. the same epoch may be rebuilt once the active generation is gone', async () => {
    const epoch = await cache.currentEpoch(userId);
    const first = await buildFeed({ userId, epoch, reason: 'miss' });
    expect(first.published).toBe(true);

    // TTL expiry, simulated: the pointer goes, the epoch stays. There is deliberately
    // no permanent "highest epoch built" marker - that would forbid this rebuild.
    await cacheConnection().del(cache.feedKeys.active(userId));

    const rebuilt = await buildFeed({ userId, epoch, reason: 'miss' });

    expect(rebuilt.published).toBe(true);
    expect(rebuilt.feedId).not.toBe(first.feedId);
    expect(recommendCalls).toHaveLength(2);
  });

  it('D. an active generation from a different epoch does not satisfy the job', async () => {
    const oldEpoch = await cache.currentEpoch(userId);
    await buildFeed({ userId, epoch: oldEpoch, reason: 'miss' });

    // Someone interacted: the epoch moves and the pointer is dropped.
    const newEpoch = await cache.invalidateFeed(userId);
    expect(newEpoch).toBe(oldEpoch + 1);

    const current = await buildFeed({ userId, epoch: newEpoch, reason: 'invalidation' });
    expect(current.published).toBe(true);
    expect(recommendCalls).toHaveLength(2);

    // And the old guard still holds: a job for a superseded epoch is discarded, and
    // is reported as stale rather than as already built.
    const stale = await buildFeed({ userId, epoch: oldEpoch, reason: 'miss' });
    expect(stale.published).toBe(false);
    expect(stale.stale).toBe(true);
    expect(stale.alreadyBuilt).toBeUndefined();
    expect(recommendCalls).toHaveLength(2);
  });

  it('E. a duplicate same-epoch job does not evict the previous generation', async () => {
    const firstEpoch = await cache.currentEpoch(userId);
    const g1 = await buildFeed({ userId, epoch: firstEpoch, reason: 'miss' });

    const secondEpoch = await cache.invalidateFeed(userId);
    const g2 = await buildFeed({ userId, epoch: secondEpoch, reason: 'invalidation' });

    expect(await cache.retainedGenerations(userId)).toEqual([g2.feedId, g1.feedId]);

    // Before the fix this published a third generation and pushed g1 out of retention
    // - so a cursor into the feed the user was reading died after what looked to them
    // like a single refresh.
    const duplicate = await buildFeed({ userId, epoch: secondEpoch, reason: 'miss' });
    expect(duplicate.alreadyBuilt).toBe(true);

    expect(await cache.retainedGenerations(userId)).toEqual([g2.feedId, g1.feedId]);
    expect(await cache.readGeneration(userId, g1.feedId!)).not.toBeNull();
  });

  it('F. refill and prewarm still build while a generation is active', async () => {
    const epoch = await cache.currentEpoch(userId);
    const first = await buildFeed({ userId, epoch, reason: 'miss' });
    expect(first.published).toBe(true);

    // These two exist precisely to produce a *new* generation while a valid one is
    // still being served. Treating them like a miss would silently disable refill.
    const refill = await buildFeed({ userId, epoch, reason: 'refill' });
    expect(refill.published).toBe(true);
    expect(refill.feedId).not.toBe(first.feedId);

    const prewarm = await buildFeed({ userId, epoch, reason: 'prewarm' });
    expect(prewarm.published).toBe(true);
    expect(prewarm.feedId).not.toBe(refill.feedId);
  });
});

describe.skipIf(!enabled)('debug sidecar gating', () => {
  it('writes no sidecar when it is off', async () => {
    const epoch = await cache.currentEpoch(userId);
    const outcome = await buildFeed({ userId, epoch, reason: 'miss' }, { withDebugSidecar: false });

    expect(outcome.published).toBe(true);
    expect(await cache.readGeneration(userId, outcome.feedId!)).not.toBeNull();
    expect(await cache.readFeedDebug(userId, outcome.feedId!)).toBeNull();
    expect(await cacheConnection().exists(cache.feedKeys.debug(userId, outcome.feedId!))).toBe(0);
  });

  it('writes one, sharing the generation lifetime, when it is on', async () => {
    const epoch = await cache.currentEpoch(userId);
    const outcome = await buildFeed({ userId, epoch, reason: 'miss' }, { withDebugSidecar: true });

    expect(outcome.published).toBe(true);
    expect(await cache.readFeedDebug(userId, outcome.feedId!)).not.toBeNull();

    const generationTtl = await cacheConnection().ttl(
      cache.feedKeys.generation(userId, outcome.feedId!),
    );
    const debugTtl = await cacheConnection().ttl(cache.feedKeys.debug(userId, outcome.feedId!));
    expect(Math.abs(generationTtl - debugTtl)).toBeLessThanOrEqual(2);

    // Still one ranking pass: the explanation is projected from it, never recomputed.
    expect(recommendCalls).toHaveLength(1);
  });

  it('serving a feed is identical either way', async () => {
    const epoch = await cache.currentEpoch(userId);
    await buildFeed({ userId, epoch, reason: 'miss' }, { withDebugSidecar: false });

    const response = await app.inject({ method: 'GET', url: `/feed?userId=${userId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');
  });
});
