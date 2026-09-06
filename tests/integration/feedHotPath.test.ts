import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * The defining property of M7: serving a cached feed must never reach the
 * recommender.
 *
 * Proved by making the recommender explode. If any part of the request path -
 * cache hit, pagination, an accidental fallback added later - called it, these
 * tests would fail loudly instead of quietly turning a Redis read into a pgvector
 * scan under load.
 */
vi.mock('../../src/reco/recommender.ts', () => ({
  recommendCandidates: vi.fn(() => {
    throw new Error('recommender must not be called on the request path');
  }),
}));

const { closeDb, db } = await import('../../src/db/client.ts');
const { users } = await import('../../src/db/schema.ts');
const { buildServer } = await import('../../src/api/server.ts');
const { closeRedis } = await import('../../src/queue/connection.ts');
const cache = await import('../../src/feed/cache.ts');
const { closeFeedQueue } = await import('../../src/feed/queue.ts');
const { recommendCandidates } = await import('../../src/reco/recommender.ts');
const { encodeCursor } = await import('../../src/feed/cursor.ts');

const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'fhot_';
let userId: string;
let app: FastifyInstance;

beforeAll(async () => {
  if (!enabled) return;
  const [user] = await db
    .insert(users)
    .values({ label: `${PREFIX}user` })
    .returning({ id: users.id });
  userId = user!.id;

  app = buildServer({ logger: false });
  await app.ready();

  await cache.publishGeneration({
    feedId: cache.newFeedId(),
    userId,
    epoch: 0,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    coldStart: false,
    candidateShortage: false,
    diversityRelaxed: false,
    items: Array.from({ length: 20 }, (_, i) => ({
      videoId: `video-${i}`,
      rank: i + 1,
      creatorId: `creator-${i}`,
    })),
  });
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  if (userId) {
    await cache.clearFeed(userId);
    await db.delete(users).where(eq(users.id, userId));
  }
  await closeFeedQueue();
  await closeRedis();
  await closeDb();
}, 60_000);

describe.skipIf(!enabled)('cache hit isolation', () => {
  it('serves a cached feed without calling the recommender', async () => {
    const response = await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=5` });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(5);
    expect(recommendCandidates).not.toHaveBeenCalled();
  });

  it('pages without calling the recommender either', async () => {
    const first = (
      await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=5` })
    ).json();

    const second = await app.inject({
      method: 'GET',
      url: `/feed?userId=${userId}&limit=5&cursor=${encodeURIComponent(first.nextCursor)}`,
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().items[0].rank).toBe(6);
    expect(recommendCandidates).not.toHaveBeenCalled();
  });

  it('answers a miss by queueing rather than by computing inline', async () => {
    await cache.clearFeed(userId);

    const response = await app.inject({ method: 'GET', url: `/feed?userId=${userId}` });

    // 202, not 500: the route enqueued a job instead of calling the exploding
    // recommender. A synchronous fallback would have thrown here.
    expect(response.statusCode).toBe(202);
    expect(recommendCandidates).not.toHaveBeenCalled();

    const cursorForGone = encodeCursor({ userId, feedId: cache.newFeedId(), offset: 0 });
    const gone = await app.inject({
      method: 'GET',
      url: `/feed?userId=${userId}&cursor=${encodeURIComponent(cursorForGone)}`,
    });
    expect(gone.statusCode).toBe(410);
    expect(recommendCandidates).not.toHaveBeenCalled();
  });
});
