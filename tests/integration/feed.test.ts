import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { closeDb, db } from '../../src/db/client.ts';
import { users, videoEmbeddings, videoFeatures, videos } from '../../src/db/schema.ts';
import { encodeFeatures } from '../../src/analysis/embedding.ts';
import { TAXONOMY_VERSION } from '../../src/analysis/taxonomy.ts';
import { PROMPT_VERSION } from '../../src/analysis/schema.ts';
import { buildServer } from '../../src/api/server.ts';
import { cacheConnection, closeRedis } from '../../src/queue/connection.ts';
import {
  type FeedGeneration,
  MAX_RETAINED_GENERATIONS_PER_USER,
  clearFeed,
  currentEpoch,
  feedKeys,
  invalidateFeed,
  newFeedId,
  publishGeneration,
  readActiveGeneration,
  readGeneration,
  retainedGenerations,
} from '../../src/feed/cache.ts';
import { closeFeedQueue, feedQueue } from '../../src/feed/queue.ts';
import { buildFeed } from '../../src/feed/worker.ts';
import { encodeCursor } from '../../src/feed/cursor.ts';
import { env } from '../../src/config/env.ts';
import { makeFeatures } from '../fixtures.ts';

/**
 * Feed serving against the real Redis, Postgres and BullMQ.
 *
 * Opt-in via TEST_INTEGRATION=1. The worker is driven inline through the same
 * `buildFeed` the background process calls, so nothing here is simulated except
 * the process boundary.
 */
const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'ftest_';
let userId: string;
let otherUserId: string;
let app: FastifyInstance;
const videoIds: string[] = [];

async function makeVideo(name: string): Promise<string> {
  const features = makeFeatures({ setting: 'pool' });
  const [row] = await db
    .insert(videos)
    .values({
      source: 'test',
      externalId: `${PREFIX}${name}`,
      creatorId: `${PREFIX}creator_${name}`,
      creatorHandle: `${PREFIX}creator_${name}`,
      s3Key: `${PREFIX}${name}.mp4`,
      durationSeconds: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1024,
      checksum: `${PREFIX}${name}-checksum`,
      status: 'analyzed',
    })
    .returning({ id: videos.id });

  const id = row!.id;
  await db.insert(videoFeatures).values({
    videoId: id,
    modelName: 'test',
    modelVersion: 'test',
    promptVersion: PROMPT_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    features,
    framesUsed: 8,
  });
  await db.insert(videoEmbeddings).values({
    videoId: id,
    taxonomyVersion: TAXONOMY_VERSION,
    embedding: encodeFeatures(features),
  });
  return id;
}

/** A generation written straight to Redis - no recommender, no database. */
function generation(overrides: Partial<FeedGeneration> = {}): FeedGeneration {
  const items = videoIds.map((videoId, index) => ({
    videoId,
    rank: index + 1,
    creatorId: `${PREFIX}creator_${index}`,
  }));
  return {
    feedId: newFeedId(),
    userId,
    epoch: 0,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    coldStart: false,
    candidateShortage: false,
    diversityRelaxed: false,
    items,
    ...overrides,
  };
}

async function clearQueue(): Promise<void> {
  const jobs = await feedQueue().getJobs(['waiting', 'delayed', 'prioritized', 'completed', 'failed']);
  for (const job of jobs) await job.remove().catch(() => {});
  await feedQueue().obliterate({ force: true }).catch(() => {});
}

beforeAll(async () => {
  if (!enabled) return;

  const [user] = await db
    .insert(users)
    .values({ label: `${PREFIX}user` })
    .returning({ id: users.id });
  userId = user!.id;
  const [other] = await db
    .insert(users)
    .values({ label: `${PREFIX}other` })
    .returning({ id: users.id });
  otherUserId = other!.id;

  for (let i = 0; i < 12; i++) videoIds.push(await makeVideo(`v${i}`));

  app = buildServer({ logger: false });
  await app.ready();
}, 90_000);

afterEach(async () => {
  if (!enabled) return;
  await clearFeed(userId);
  await clearFeed(otherUserId);
  await clearQueue();
});

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  for (const id of [userId, otherUserId]) {
    if (id) await db.delete(users).where(eq(users.id, id));
  }
  await db.delete(videos).where(like(videos.externalId, `${PREFIX}%`));
  await closeFeedQueue();
  await closeRedis();
  await closeDb();
}, 90_000);

describe.skipIf(!enabled)('feed cache', () => {
  it('round-trips a generation and points the active pointer at it', async () => {
    const feed = generation();
    await publishGeneration(feed);

    const byId = await readGeneration(userId, feed.feedId);
    expect(byId?.feedId).toBe(feed.feedId);
    expect(byId?.items).toHaveLength(videoIds.length);

    const active = await readActiveGeneration(userId);
    expect(active?.feedId).toBe(feed.feedId);
  });

  it('gives the generation a longer life than the pointer, so cursors outlive a refresh', async () => {
    const feed = generation();
    await publishGeneration(feed);

    const redis = cacheConnection();
    const pointerTtl = await redis.ttl(feedKeys.active(userId));
    const generationTtl = await redis.ttl(feedKeys.generation(userId, feed.feedId));

    expect(pointerTtl).toBeGreaterThan(0);
    expect(generationTtl).toBeGreaterThan(pointerTtl);
  });

  it('serves an old generation through its cursor after the pointer moved on', async () => {
    const first = generation();
    await publishGeneration(first);
    const second = generation();
    await publishGeneration(second);

    expect((await readActiveGeneration(userId))?.feedId).toBe(second.feedId);
    // The superseded generation is still addressable - a client mid-scroll keeps
    // reading the list it started on.
    expect((await readGeneration(userId, first.feedId))?.feedId).toBe(first.feedId);
  });

  it('treats an expired pointer as no feed rather than as an error', async () => {
    const feed = generation();
    await publishGeneration(feed);
    await cacheConnection().del(feedKeys.active(userId));

    expect(await readActiveGeneration(userId)).toBeNull();
  });

  it('caches an empty feed as a ready answer', async () => {
    await publishGeneration(generation({ items: [] }));

    const response = await app.inject({ method: 'GET', url: `/feed?userId=${userId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
    expect(response.json().hasMore).toBe(false);

    // The point: an empty feed must not look like a miss, or every request would
    // queue another build forever.
    expect(await feedQueue().getJobs(['waiting', 'delayed'])).toHaveLength(0);
  });
});

describe.skipIf(!enabled)('GET /feed', () => {
  it('answers 202 and queues a build when nothing is cached', async () => {
    const response = await app.inject({ method: 'GET', url: `/feed?userId=${userId}` });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('building');
    expect(await feedQueue().getJobs(['waiting', 'delayed', 'active'])).not.toHaveLength(0);
  });

  it('serves a cached feed with a cursor', async () => {
    await publishGeneration(generation());

    const response = await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=5` });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.items).toHaveLength(5);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe('string');
  });

  it('pages through one generation without repeating an item', async () => {
    const feed = generation();
    await publishGeneration(feed);

    const seen: string[] = [];
    let cursor: string | null = null;
    const feedIds = new Set<string>();

    for (let page = 0; page < 10; page++) {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const body = (
        await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=5${suffix}` })
      ).json() as { feedId: string; items: { videoId: string }[]; nextCursor: string | null };
      feedIds.add(body.feedId);
      seen.push(...body.items.map((i) => i.videoId));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(videoIds.length);
    expect(new Set(seen).size).toBe(videoIds.length);
    // Every page came from the same immutable generation.
    expect(feedIds.size).toBe(1);
  });

  it('ends pagination exactly on the boundary', async () => {
    await publishGeneration(generation());

    const body = (
      await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=${videoIds.length}` })
    ).json();
    expect(body.items).toHaveLength(videoIds.length);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor with 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/feed?userId=${userId}&cursor=garbage!!`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_cursor');
  });

  it("rejects another user's cursor with 400", async () => {
    const feed = generation();
    await publishGeneration(feed);
    const foreign = encodeCursor({ userId: otherUserId, feedId: feed.feedId, offset: 0 });

    const response = await app.inject({
      method: 'GET',
      url: `/feed?userId=${userId}&cursor=${encodeURIComponent(foreign)}`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 410 for a cursor whose generation has expired', async () => {
    const cursor = encodeCursor({ userId, feedId: newFeedId(), offset: 5 });
    const response = await app.inject({
      method: 'GET',
      url: `/feed?userId=${userId}&cursor=${encodeURIComponent(cursor)}`,
    });

    expect(response.statusCode).toBe(410);
    expect(response.json().error).toBe('feed_expired');
  });

  it('validates limit and rejects an unknown user', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=0` })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=99999` })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/feed?userId=not-a-uuid' })).statusCode).toBe(
      400,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/feed?userId=00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe.skipIf(!enabled)('build deduplication and epochs', () => {
  it('collapses concurrent cache misses into one build', async () => {
    const requests = Array.from({ length: 25 }, () =>
      app.inject({ method: 'GET', url: `/feed?userId=${userId}` }),
    );
    const responses = await Promise.all(requests);

    expect(responses.every((r) => r.statusCode === 202)).toBe(true);

    const jobs = await feedQueue().getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    // BullMQ deduplication keys on user+epoch, so 25 misses are one logical build.
    expect(jobs.length).toBeLessThanOrEqual(1);
  });

  it('discards a build whose epoch was superseded while it ran', async () => {
    const staleEpoch = await currentEpoch(userId);
    await invalidateFeed(userId); // someone interacted: epoch moves on

    const outcome = await buildFeed({ userId, epoch: staleEpoch, reason: 'miss' });

    expect(outcome.published).toBe(false);
    expect(outcome.stale).toBe(true);
    expect(await readActiveGeneration(userId)).toBeNull();
  });

  it('publishes a build for the current epoch', async () => {
    const epoch = await currentEpoch(userId);
    const outcome = await buildFeed({ userId, epoch, reason: 'miss' });

    expect(outcome.published).toBe(true);
    expect((await readActiveGeneration(userId))?.feedId).toBe(outcome.feedId);
  });

  it('never lets a late stale build overwrite a newer feed', async () => {
    const oldEpoch = await currentEpoch(userId);

    // The newer build lands first...
    await invalidateFeed(userId);
    const newEpoch = await currentEpoch(userId);
    await buildFeed({ userId, epoch: newEpoch, reason: 'invalidation' });
    const current = await readActiveGeneration(userId);

    // ...then the older one finishes and must not win.
    await buildFeed({ userId, epoch: oldEpoch, reason: 'miss' });

    expect((await readActiveGeneration(userId))?.feedId).toBe(current?.feedId);
  });
});

describe.skipIf(!enabled)('interaction invalidation', () => {
  it('bumps the epoch once for an accepted event and queues a rebuild', async () => {
    await publishGeneration(generation());
    const before = await currentEpoch(userId);

    const payload = {
      eventId: `${PREFIX}evt-${Date.now()}`,
      userId,
      videoId: videoIds[0],
      type: 'like',
    };
    const accepted = await app.inject({ method: 'POST', url: '/interactions', payload });

    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().feedInvalidated).toBe(true);
    expect(await currentEpoch(userId)).toBe(before + 1);
    // The stale feed is gone, so the next request cannot be served pre-interaction.
    expect(await readActiveGeneration(userId)).toBeNull();
  });

  it('does not invalidate again for a duplicate event', async () => {
    const payload = {
      eventId: `${PREFIX}dup-${Date.now()}`,
      userId,
      videoId: videoIds[1],
      type: 'like',
    };
    await app.inject({ method: 'POST', url: '/interactions', payload });
    const afterFirst = await currentEpoch(userId);

    const duplicate = await app.inject({ method: 'POST', url: '/interactions', payload });

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    expect(duplicate.json().feedInvalidated).toBe(false);
    expect(await currentEpoch(userId)).toBe(afterFirst);
  });

  it('records an impression without invalidating the feed', async () => {
    // A client showing ten items sends ten impressions. Since the epoch is the
    // deduplication key, invalidating on each would mean ten separate builds -
    // exactly the amplification the epoch was meant to prevent.
    const feed = generation();
    await publishGeneration(feed);
    const before = await currentEpoch(userId);

    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: {
        eventId: `${PREFIX}imp-${Date.now()}`,
        userId,
        videoId: videoIds[2],
        type: 'impression',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().recorded).toBe(true);
    expect(response.json().feedInvalidated).toBe(false);

    expect(await currentEpoch(userId)).toBe(before);
    // The session keeps reading the generation it is scrolling through.
    expect((await readActiveGeneration(userId))?.feedId).toBe(feed.feedId);
    expect(await feedQueue().getJobs(['waiting', 'delayed', 'active'])).toHaveLength(0);
  });

  it('still makes an impressed video seen for the next build', async () => {
    const target = videoIds[3]!;
    await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: {
        eventId: `${PREFIX}imp-seen-${Date.now()}`,
        userId,
        videoId: target,
        type: 'impression',
      },
    });

    // Deferred, not discarded: the next generation excludes it.
    const outcome = await buildFeed({ userId, epoch: await currentEpoch(userId), reason: 'miss' });
    expect(outcome.published).toBe(true);

    const built = await readActiveGeneration(userId);
    expect(built!.items.map((i) => i.videoId)).not.toContain(target);
  });

  it('ten impressions produce no builds at all', async () => {
    await publishGeneration(generation());

    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/interactions',
        payload: {
          eventId: `${PREFIX}burst-${Date.now()}-${i}`,
          userId,
          videoId: videoIds[i % videoIds.length],
          type: 'impression',
        },
      });
    }

    expect(await currentEpoch(userId)).toBe(0);
    expect(await feedQueue().getJobs(['waiting', 'delayed', 'active'])).toHaveLength(0);
  });

  it('invalidates for every preference-changing event type', async () => {
    for (const type of ['view', 'complete', 'like', 'skip', 'dislike'] as const) {
      await publishGeneration(generation());
      const before = await currentEpoch(userId);

      const response = await app.inject({
        method: 'POST',
        url: '/interactions',
        payload: {
          eventId: `${PREFIX}${type}-${Date.now()}`,
          userId,
          videoId: videoIds[4],
          type,
        },
      });

      expect(response.json().feedInvalidated, `${type} must invalidate`).toBe(true);
      expect(await currentEpoch(userId)).toBe(before + 1);
      expect(await readActiveGeneration(userId)).toBeNull();
    }
  });
});

describe.skipIf(!enabled)('generation retention', () => {
  it('keeps the first generation', async () => {
    const first = generation();
    await publishGeneration(first);

    expect(await retainedGenerations(userId)).toEqual([first.feedId]);
  });

  it('keeps the current and the previous generation', async () => {
    const first = generation();
    const second = generation();
    await publishGeneration(first);
    await publishGeneration(second);

    expect(await retainedGenerations(userId)).toEqual([second.feedId, first.feedId]);
    expect(await readGeneration(userId, first.feedId)).not.toBeNull();
    expect(await readGeneration(userId, second.feedId)).not.toBeNull();
  });

  it('evicts the oldest when a third arrives, and never the active one', async () => {
    const first = generation();
    const second = generation();
    const third = generation();
    await publishGeneration(first);
    await publishGeneration(second);
    await publishGeneration(third);

    expect(await retainedGenerations(userId)).toEqual([third.feedId, second.feedId]);
    expect(await readGeneration(userId, first.feedId)).toBeNull();
    // The active pointer still resolves - the invariant that matters most.
    expect((await readActiveGeneration(userId))?.feedId).toBe(third.feedId);
  });

  it('stays bounded through rapid rebuilds', async () => {
    for (let i = 0; i < 20; i++) await publishGeneration(generation());

    const retained = await retainedGenerations(userId);
    expect(retained).toHaveLength(MAX_RETAINED_GENERATIONS_PER_USER);
    expect((await readActiveGeneration(userId))?.feedId).toBe(retained[0]);

    // And no orphaned payloads left behind by the trimming.
    const live = await cacheConnection().keys(`feed:gen:${userId}:*`);
    expect(live).toHaveLength(MAX_RETAINED_GENERATIONS_PER_USER);
  });

  it('applies retention to empty generations too', async () => {
    for (let i = 0; i < 5; i++) await publishGeneration(generation({ items: [] }));

    expect(await retainedGenerations(userId)).toHaveLength(MAX_RETAINED_GENERATIONS_PER_USER);
  });

  it('serves a cursor into the previous generation, and 410 once it is evicted', async () => {
    const first = generation();
    await publishGeneration(first);
    const cursor = encodeCursor({ userId, feedId: first.feedId, offset: 4 });

    // One rebuild: the old cursor still reads its own generation.
    await publishGeneration(generation());
    const afterOne = await app.inject({
      method: 'GET',
      url: `/feed?userId=${userId}&limit=2&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(afterOne.statusCode).toBe(200);
    expect(afterOne.json().feedId).toBe(first.feedId);

    // Two rebuilds: it has been evicted, and the client is told to start over.
    await publishGeneration(generation());
    const afterTwo = await app.inject({
      method: 'GET',
      url: `/feed?userId=${userId}&limit=2&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(afterTwo.statusCode).toBe(410);
    expect(afterTwo.json().error).toBe('feed_expired');
  });
});

describe.skipIf(!enabled)('refill', () => {
  it('does not queue a refill while plenty of items remain', async () => {
    await publishGeneration(generation());
    await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=1` });

    expect(await feedQueue().getJobs(['waiting', 'delayed'])).toHaveLength(0);
  });

  it('queues one refill near the tail, and only one however many times it is read', async () => {
    await publishGeneration(generation());
    const nearEnd = encodeCursor({
      userId,
      feedId: (await readActiveGeneration(userId))!.feedId,
      offset: videoIds.length - env.FEED_REFILL_WATERMARK,
    });

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'GET',
        url: `/feed?userId=${userId}&limit=2&cursor=${encodeURIComponent(nearEnd)}`,
      });
    }

    const jobs = await feedQueue().getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    expect(jobs.length).toBeLessThanOrEqual(1);
  });

  it('does not refill a generation that already reported a candidate shortage', async () => {
    // Rebuilding cannot invent videos that do not exist, so this would loop.
    await publishGeneration(generation({ items: [], candidateShortage: true }));
    await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=5` });

    expect(await feedQueue().getJobs(['waiting', 'delayed'])).toHaveLength(0);
  });
});
