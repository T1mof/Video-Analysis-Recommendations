import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * The demo surface.
 *
 * Two properties are worth a test rather than a comment:
 *
 *   1. **Explaining a feed costs no ranking.** The debug endpoint reads one Redis key.
 *      Proved the same way the feed hot path is - by making the recommender throw. If
 *      anyone ever "helpfully" recomputes a missing explanation, this fails loudly
 *      instead of quietly putting pgvector behind a demo page.
 *   2. **The sidecar shares the generation's lifetime.** An explanation that outlived
 *      the ranking it describes would be worse than no explanation, so eviction has
 *      to take both keys.
 */
vi.mock('../../src/reco/recommender.ts', () => ({
  recommendCandidates: vi.fn(() => {
    throw new Error('recommender must not be called by the demo surface');
  }),
}));

const { closeDb, db } = await import('../../src/db/client.ts');
const { users } = await import('../../src/db/schema.ts');
const { buildServer } = await import('../../src/api/server.ts');
const { closeRedis } = await import('../../src/queue/connection.ts');
const cache = await import('../../src/feed/cache.ts');
const { closeFeedQueue } = await import('../../src/feed/queue.ts');
const { recommendCandidates } = await import('../../src/reco/recommender.ts');
const { MAX_RETAINED_GENERATIONS_PER_USER } = cache;

import type { FeedDebugGeneration } from '../../src/feed/debug.ts';

const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'demo_';
let userId: string;
let otherUserId: string;
let app: FastifyInstance;

function generation(feedId = cache.newFeedId(), videoId = '00000000-0000-4000-8000-000000000001') {
  return {
    feedId,
    userId,
    epoch: 0,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    coldStart: false,
    candidateShortage: false,
    diversityRelaxed: false,
    items: [{ videoId, rank: 1, creatorId: 'creator-1' }],
  };
}

function debugFor(feedId: string, videoId = '00000000-0000-4000-8000-000000000001'): FeedDebugGeneration {
  return {
    feedId,
    userId,
    epoch: 0,
    generatedAt: new Date().toISOString(),
    coldStart: false,
    weights: { affinity: 1 },
    candidateCounts: { similar: 1, tag: 0, trending: 0, fresh: 0, explore: 0 },
    uniqueCandidates: 1,
    eligibleVideos: 1,
    filteredSeen: 0,
    candidateShortage: false,
    diversityRelaxed: false,
    relaxedCount: 0,
    buildLatencyMs: 3,
    items: [
      {
        videoId,
        rank: 1,
        sources: ['similar'],
        creatorHandle: 'demo_creator_01',
        externalId: 'video_01',
        tags: ['setting:pool'],
        features: {
          contentSimilarity: 0.2,
          tagAffinity: 0.1,
          affinity: 0.15,
          creatorAffinity: 0.3,
          popularity: 0.5,
          freshness: 0.9,
          fatigue: 0.1,
          exploration: 0.4,
          quality: 0.6,
          qualityAvailable: true,
        },
        weighted: { affinity: 0.15 },
        baseScore: 0.4,
        diversityPenalty: 0,
        finalScore: 0.4,
        admittedByRelaxation: false,
      },
    ],
  };
}

beforeAll(async () => {
  if (!enabled) return;

  const inserted = await db
    .insert(users)
    .values([{ label: `${PREFIX}user` }, { label: `${PREFIX}other` }])
    .returning({ id: users.id });
  userId = inserted[0]!.id;
  otherUserId = inserted[1]!.id;

  app = buildServer({ logger: false });
  await app.ready();
}, 60_000);

afterEach(async () => {
  if (!enabled) return;
  await cache.clearFeed(userId);
  await cache.clearFeed(otherUserId);
});

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  for (const id of [userId, otherUserId]) {
    if (id) await db.delete(users).where(eq(users.id, id));
  }
  await closeFeedQueue();
  await closeRedis();
  await closeDb();
}, 60_000);

describe.skipIf(!enabled)('demo page', () => {
  it('serves the page at /demo/ and redirects /demo to it', async () => {
    const redirect = await app.inject({ method: 'GET', url: '/demo' });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/demo/');

    const page = await app.inject({ method: 'GET', url: '/demo/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    // The page must be a client of the real API, not of a demo-only feed route.
    expect(page.body).toContain('/interactions');
  });

  it('serves the stylesheet and the script', async () => {
    const css = await app.inject({ method: 'GET', url: '/demo/styles.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');

    const js = await app.inject({ method: 'GET', url: '/demo/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
  });
});

describe.skipIf(!enabled)('feed-debug endpoint', () => {
  it('returns a stored explanation without calling the recommender', async () => {
    const feed = generation();
    await cache.publishGeneration(feed, debugFor(feed.feedId));

    const response = await app.inject({
      method: 'GET',
      url: `/demo/api/feed-debug?userId=${userId}&feedId=${feed.feedId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.available).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].sources).toEqual(['similar']);
    expect(body.items[0].finalScore).toBe(0.4);
    // Media is a signed storage URL: the API hands out a link and never proxies bytes.
    expect(body.items[0].posterUrl).toContain('thumbs/');
    expect(body.items[0].mediaUrl).toContain('videos/');

    expect(recommendCandidates).not.toHaveBeenCalled();
  });

  it('refuses one user a feed belonging to another', async () => {
    const feed = generation();
    await cache.publishGeneration(feed, debugFor(feed.feedId));

    const response = await app.inject({
      method: 'GET',
      url: `/demo/api/feed-debug?userId=${otherUserId}&feedId=${feed.feedId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().available).toBe(false);
    expect(recommendCandidates).not.toHaveBeenCalled();
  });

  it('rejects a malformed feedId and reports an absent sidecar as unavailable', async () => {
    const malformed = await app.inject({
      method: 'GET',
      url: `/demo/api/feed-debug?userId=${userId}&feedId=not-a-uuid`,
    });
    expect(malformed.statusCode).toBe(400);

    // A generation published without a sidecar is a perfectly good feed. The demo
    // degrades to metadata rather than reporting a fault.
    const feed = generation();
    await cache.publishGeneration(feed);
    const missing = await app.inject({
      method: 'GET',
      url: `/demo/api/feed-debug?userId=${userId}&feedId=${feed.feedId}`,
    });
    expect(missing.statusCode).toBe(404);

    // Asserted as a contract rather than against a fixed value: "switched off" and
    // "on, but this generation has none" are different answers, and which one applies
    // depends on configuration this test has no business pinning.
    const body = missing.json();
    expect(body.available).toBe(false);
    expect(body.error).toBe(body.sidecarEnabled ? 'no_debug_data' : 'debug_sidecar_disabled');

    expect(recommendCandidates).not.toHaveBeenCalled();
  });
});

describe.skipIf(!enabled)('sidecar retention', () => {
  it('evicts the explanation with the generation it explains', async () => {
    const feedIds: string[] = [];
    for (let i = 0; i < MAX_RETAINED_GENERATIONS_PER_USER + 1; i++) {
      const feed = generation();
      feedIds.push(feed.feedId);
      await cache.publishGeneration(feed, debugFor(feed.feedId));
    }

    const retained = await cache.retainedGenerations(userId);
    expect(retained).toHaveLength(MAX_RETAINED_GENERATIONS_PER_USER);

    const [evicted, ...survivors] = feedIds;

    // The pair goes together. A surviving sidecar would describe a ranking nobody can
    // read; a missing one for a live generation would silently disable the demo panel.
    expect(await cache.readGeneration(userId, evicted!)).toBeNull();
    expect(await cache.readFeedDebug(userId, evicted!)).toBeNull();

    for (const feedId of survivors) {
      expect(await cache.readGeneration(userId, feedId)).not.toBeNull();
      expect(await cache.readFeedDebug(userId, feedId)).not.toBeNull();
    }
  });

  it('clearing a feed removes the sidecars too', async () => {
    const feed = generation();
    await cache.publishGeneration(feed, debugFor(feed.feedId));
    expect(await cache.readFeedDebug(userId, feed.feedId)).not.toBeNull();

    await cache.clearFeed(userId);

    expect(await cache.readFeedDebug(userId, feed.feedId)).toBeNull();
  });
});
