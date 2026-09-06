import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type * as QueueModule from '../../src/feed/queue.ts';

/**
 * Feed invalidation: is it one grouped Redis operation, and what happens when the
 * queue write after it fails?
 *
 * The failure this guards against is subtle. Sent as two independent commands, a
 * connection drop between `INCR epoch` and `DEL active` leaves the epoch advanced
 * while the pointer survives - so `/feed` serves a generation that predates the
 * interaction until the TTL expires an hour later. Grouping them in MULTI/EXEC is
 * what makes the pair inseparable.
 */

/** Enqueue failures are injected per test rather than for the whole file. */
let enqueueFailsOnce = false;
const enqueueCalls: unknown[] = [];

vi.mock('../../src/feed/queue.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>();
  return {
    ...actual,
    enqueueFeedBuild: vi.fn(async (job: QueueModule.FeedJob, dedupeId?: string) => {
      enqueueCalls.push(job);
      if (enqueueFailsOnce) {
        enqueueFailsOnce = false;
        throw new Error('queue unavailable');
      }
      return actual.enqueueFeedBuild(job, dedupeId);
    }),
  };
});

const { closeDb, db } = await import('../../src/db/client.ts');
const { users, videoEmbeddings, videoFeatures, videos } = await import('../../src/db/schema.ts');
const { encodeFeatures } = await import('../../src/analysis/embedding.ts');
const { TAXONOMY_VERSION } = await import('../../src/analysis/taxonomy.ts');
const { PROMPT_VERSION } = await import('../../src/analysis/schema.ts');
const { buildServer } = await import('../../src/api/server.ts');
const { cacheConnection, closeRedis } = await import('../../src/queue/connection.ts');
const cache = await import('../../src/feed/cache.ts');
const { closeFeedQueue, feedQueue } = await import('../../src/feed/queue.ts');
const { makeFeatures } = await import('../fixtures.ts');

const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'finv_';
let userId: string;
let videoId: string;
let app: FastifyInstance;

function generation(feedId = cache.newFeedId()) {
  return {
    feedId,
    userId,
    epoch: 0,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    coldStart: false,
    candidateShortage: false,
    diversityRelaxed: false,
    items: [{ videoId, rank: 1, creatorId: null }],
  };
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
  enqueueFailsOnce = false;
  enqueueCalls.length = 0;
  await cache.clearFeed(userId);
  for (const job of await feedQueue().getJobs(['waiting', 'delayed', 'active', 'prioritized'])) {
    await job.remove().catch(() => {});
  }
  vi.restoreAllMocks();
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

describe.skipIf(!enabled)('atomic invalidation', () => {
  it('advances the epoch and drops the pointer together', async () => {
    // Start from a known epoch rather than zero, so the assertion is about the
    // increment rather than about initialisation.
    for (let i = 0; i < 4; i++) await cache.invalidateFeed(userId);
    const feed = generation();
    await cache.publishGeneration(feed);

    expect(await cache.currentEpoch(userId)).toBe(4);
    expect((await cache.readActiveGeneration(userId))?.feedId).toBe(feed.feedId);

    const epoch = await cache.invalidateFeed(userId);

    expect(epoch).toBe(5);
    expect(await cache.currentEpoch(userId)).toBe(5);
    expect(await cache.readActiveGeneration(userId)).toBeNull();
  });

  it('issues both effects as one MULTI, never as two loose commands', async () => {
    const redis = cacheConnection();
    const multiSpy = vi.spyOn(redis, 'multi');
    const incrSpy = vi.spyOn(redis, 'incr');
    const delSpy = vi.spyOn(redis, 'del');

    await cache.invalidateFeed(userId);

    // The grouping is the guarantee: there is no window in which another client
    // could observe a new epoch beside a surviving pointer.
    expect(multiSpy).toHaveBeenCalledTimes(1);
    expect(incrSpy).not.toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
  });

  it('keeps epoch and pointer consistent under concurrent invalidations', async () => {
    await cache.publishGeneration(generation());

    const epochs = await Promise.all(
      Array.from({ length: 10 }, () => cache.invalidateFeed(userId)),
    );

    // Every caller got a distinct epoch - no two builds can share one.
    expect(new Set(epochs).size).toBe(epochs.length);
    expect(await cache.currentEpoch(userId)).toBe(Math.max(...epochs));
    expect(await cache.readActiveGeneration(userId)).toBeNull();
  });
});

describe.skipIf(!enabled)('queue failure after invalidation', () => {
  it('keeps the interaction, leaves a miss rather than a stale feed, and recovers', async () => {
    const feed = generation();
    await cache.publishGeneration(feed);
    const epochBefore = await cache.currentEpoch(userId);

    enqueueFailsOnce = true;
    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: { eventId: `${PREFIX}like-${Date.now()}`, userId, videoId, type: 'like' },
    });

    // The interaction is durable in Postgres; a queue outage must not undo it.
    expect(response.statusCode).toBe(201);
    expect(response.json().recorded).toBe(true);
    // Two separate facts, reported separately: the cache *was* invalidated, the
    // rebuild was not queued. Collapsing them into one flag would claim the feed
    // was left untouched when it had already been dropped.
    expect(response.json().feedInvalidated).toBe(true);
    expect(response.json().rebuildQueued).toBe(false);

    // Redis invalidation happened before the enqueue attempt, so the stale feed is
    // gone even though the rebuild was never queued.
    expect(await cache.currentEpoch(userId)).toBe(epochBefore + 1);
    expect(await cache.readActiveGeneration(userId)).toBeNull();

    // The next request sees a miss - never the pre-interaction feed - and queues
    // the build itself, so the system heals without operator action.
    const feedResponse = await app.inject({ method: 'GET', url: `/feed?userId=${userId}` });
    expect(feedResponse.statusCode).toBe(202);
    expect(feedResponse.json().status).toBe('building');
    expect(await feedQueue().getJobs(['waiting', 'delayed', 'active'])).not.toHaveLength(0);
  });
});

describe.skipIf(!enabled)('events that must not invalidate', () => {
  it('does not run the transaction for a duplicate interaction', async () => {
    const payload = { eventId: `${PREFIX}dup-${Date.now()}`, userId, videoId, type: 'like' };
    await app.inject({ method: 'POST', url: '/interactions', payload });

    const feed = generation();
    await cache.publishGeneration(feed);
    const epochBefore = await cache.currentEpoch(userId);
    const multiSpy = vi.spyOn(cacheConnection(), 'multi');

    const duplicate = await app.inject({ method: 'POST', url: '/interactions', payload });

    expect(duplicate.json().duplicate).toBe(true);
    expect(multiSpy).not.toHaveBeenCalled();
    expect(await cache.currentEpoch(userId)).toBe(epochBefore);
    expect((await cache.readActiveGeneration(userId))?.feedId).toBe(feed.feedId);
  });

  it('does not run the transaction for an impression', async () => {
    const feed = generation();
    await cache.publishGeneration(feed);
    const epochBefore = await cache.currentEpoch(userId);
    const multiSpy = vi.spyOn(cacheConnection(), 'multi');

    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: {
        eventId: `${PREFIX}imp-${Date.now()}`,
        userId,
        videoId,
        type: 'impression',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().feedInvalidated).toBe(false);
    expect(multiSpy).not.toHaveBeenCalled();
    expect(await cache.currentEpoch(userId)).toBe(epochBefore);
    expect((await cache.readActiveGeneration(userId))?.feedId).toBe(feed.feedId);
  });
});
