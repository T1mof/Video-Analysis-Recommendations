import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { closeDb, db } from '../../src/db/client.ts';
import {
  events,
  userCreatorAffinity,
  userProfiles,
  users,
  videoEmbeddings,
  videos,
} from '../../src/db/schema.ts';
import { encodeFeatures } from '../../src/analysis/embedding.ts';
import { TAXONOMY_DIM, TAXONOMY_VERSION } from '../../src/analysis/taxonomy.ts';
import { recordInteraction, UnknownReferenceError } from '../../src/reco/interactions.ts';
import { getUserProfile, rebuildUserProfile } from '../../src/reco/profile.ts';
import { buildServer } from '../../src/api/server.ts';
import { makeFeatures } from '../fixtures.ts';

/**
 * Interaction intake and profile materialisation against the real Postgres.
 *
 * Opt-in via TEST_INTEGRATION=1. Rows are created directly rather than through
 * ingestion: this covers the profile path, and pulling MinIO and ffmpeg into it
 * would only make it slower and flakier.
 */
const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'itest_';
let userId: string;
let analysedVideoId: string;
let unanalysedVideoId: string;
let app: FastifyInstance;

async function makeVideo(externalId: string, creatorId: string): Promise<string> {
  const [row] = await db
    .insert(videos)
    .values({
      source: 'test',
      externalId: `${PREFIX}${externalId}`,
      creatorId: `${PREFIX}${creatorId}`,
      creatorHandle: `${PREFIX}${creatorId}`,
      s3Key: `${PREFIX}${externalId}.mp4`,
      durationSeconds: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1024,
      checksum: `${PREFIX}${externalId}-checksum`,
      status: 'analyzed',
    })
    .returning({ id: videos.id });
  return row!.id;
}

beforeAll(async () => {
  if (!enabled) return;

  const [user] = await db
    .insert(users)
    .values({ label: `${PREFIX}user` })
    .returning({ id: users.id });
  userId = user!.id;

  analysedVideoId = await makeVideo('analysed', 'creator_a');
  unanalysedVideoId = await makeVideo('unanalysed', 'creator_b');

  await db.insert(videoEmbeddings).values({
    videoId: analysedVideoId,
    taxonomyVersion: TAXONOMY_VERSION,
    embedding: encodeFeatures(makeFeatures({ hairColor: 'blonde' })),
  });

  app = buildServer();
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  if (userId) await db.delete(users).where(eq(users.id, userId)); // cascades events/profile
  await db.delete(videos).where(like(videos.externalId, `${PREFIX}%`));
  await closeDb();
}, 60_000);

describe.skipIf(!enabled)('interactions and profile (integration)', () => {
  it('records an interaction and materialises a profile', async () => {
    await recordInteraction({
      eventId: `${PREFIX}like-1`,
      userId,
      videoId: analysedVideoId,
      type: 'like',
      watchRatio: 0.9,
    });

    const profile = await rebuildUserProfile(userId);
    expect(profile.effectiveSignalCount).toBe(1);
    expect(profile.vector).toHaveLength(TAXONOMY_DIM);

    const stored = await getUserProfile(userId);
    expect(stored).not.toBeNull();
    expect(stored!.vector).toHaveLength(TAXONOMY_DIM);
    expect(stored!.effectiveSignalCount).toBe(1);
    expect(stored!.isColdStart).toBe(true);
  });

  it('treats a repeated eventId as a no-op, in the row count and in the profile', async () => {
    const before = await rebuildUserProfile(userId);

    const duplicate = await recordInteraction({
      eventId: `${PREFIX}like-1`,
      userId,
      videoId: analysedVideoId,
      type: 'like',
      watchRatio: 0.9,
    });
    expect(duplicate.recorded).toBe(false);

    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.eventId, `${PREFIX}like-1`));
    expect(rows).toHaveLength(1);

    const after = await rebuildUserProfile(userId);
    expect(after.effectiveSignalCount).toBe(before.effectiveSignalCount);
    expect(after.positiveSignal).toBeCloseTo(before.positiveSignal, 6);
  });

  it('stores an interaction with an unanalysed video without polluting the vector', async () => {
    await recordInteraction({
      eventId: `${PREFIX}like-unanalysed`,
      userId,
      videoId: unanalysedVideoId,
      type: 'like',
    });

    const profile = await rebuildUserProfile(userId);
    expect(profile.skippedNoFeatures).toBeGreaterThanOrEqual(1);
    expect(profile.vector.every(Number.isFinite)).toBe(true);
    expect(profile.creatorAffinity.map((c) => c.creatorId)).not.toContain(`${PREFIX}creator_b`);

    const saved = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.eventId, `${PREFIX}like-unanalysed`));
    expect(saved).toHaveLength(1);
  });

  it('rejects an unknown user or video instead of raising a foreign-key error', async () => {
    await expect(
      recordInteraction({
        userId: '00000000-0000-4000-8000-000000000000',
        videoId: analysedVideoId,
        type: 'like',
      }),
    ).rejects.toBeInstanceOf(UnknownReferenceError);
  });

  it('persists creator affinity as queryable rows', async () => {
    await rebuildUserProfile(userId);
    const rows = await db
      .select()
      .from(userCreatorAffinity)
      .where(eq(userCreatorAffinity.userId, userId));

    expect(rows.length).toBeGreaterThan(0);
    const creatorA = rows.find((r) => r.creatorId === `${PREFIX}creator_a`);
    expect(creatorA).toBeDefined();
    expect(creatorA!.score).toBeGreaterThan(0);
  });

  it('crosses out of cold start once enough meaningful signals exist', async () => {
    for (let i = 0; i < 6; i++) {
      await recordInteraction({
        eventId: `${PREFIX}warm-${i}`,
        userId,
        videoId: analysedVideoId,
        type: 'view',
      });
    }
    const profile = await rebuildUserProfile(userId);
    expect(profile.effectiveSignalCount).toBeGreaterThanOrEqual(5);
    expect(profile.isColdStart).toBe(false);

    const [stored] = await db
      .select({ cold: userProfiles.isColdStart })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId));
    expect(stored!.cold).toBe(false);
  });

  it('does not let impressions alone warm a profile', async () => {
    const [other] = await db
      .insert(users)
      .values({ label: `${PREFIX}impressions_only` })
      .returning({ id: users.id });

    for (let i = 0; i < 8; i++) {
      await recordInteraction({
        eventId: `${PREFIX}imp-${i}`,
        userId: other!.id,
        videoId: analysedVideoId,
        type: 'impression',
      });
    }

    const profile = await rebuildUserProfile(other!.id);
    expect(profile.interactionCount).toBe(8);
    expect(profile.effectiveSignalCount).toBe(0);
    expect(profile.isColdStart).toBe(true);
    expect(profile.vector.every((v) => v === 0)).toBe(true);

    await db.delete(users).where(inArray(users.id, [other!.id]));
  });
});

describe.skipIf(!enabled)('interaction API', () => {
  it('accepts an interaction and reports the resulting profile state', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: {
        eventId: `${PREFIX}api-like`,
        userId,
        videoId: analysedVideoId,
        type: 'like',
        watchRatio: 0.95,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.recorded).toBe(true);
    expect(body.profile.effectiveSignalCount).toBeGreaterThan(0);
  });

  it('answers 200 with duplicate=true on a retry, not 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: {
        eventId: `${PREFIX}api-like`,
        userId,
        videoId: analysedVideoId,
        type: 'like',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().duplicate).toBe(true);
  });

  it('rejects an event type outside the taxonomy of signals', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: { userId, videoId: analysedVideoId, type: 'superlike' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_interaction');
  });

  it('rejects the legacy watch type, so one playback cannot count twice', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: { userId, videoId: analysedVideoId, type: 'watch' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for an unknown video', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: {
        userId,
        videoId: '00000000-0000-4000-8000-000000000000',
        type: 'like',
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('explains a profile without dumping the raw vector by default', async () => {
    const response = await app.inject({ method: 'GET', url: `/users/${userId}/profile` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.vector).toBeUndefined();
    expect(Array.isArray(body.topPositivePreferences)).toBe(true);
    expect(Array.isArray(body.creatorAffinity)).toBe(true);
    expect(body.taxonomyVersion).toBe(TAXONOMY_VERSION);

    const withVector = await app.inject({
      method: 'GET',
      url: `/users/${userId}/profile?vector=true`,
    });
    expect(withVector.json().vector).toHaveLength(TAXONOMY_DIM);
  });

  it('404s for a user with no profile yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/users/00000000-0000-4000-8000-000000000000/profile',
    });
    expect(response.statusCode).toBe(404);
  });
});
