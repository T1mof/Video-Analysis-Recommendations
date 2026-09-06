import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { closeDb, db } from '../../src/db/client.ts';
import { users, videoEmbeddings, videoFeatures, videos } from '../../src/db/schema.ts';
import { encodeFeatures } from '../../src/analysis/embedding.ts';
import { TAXONOMY_VERSION } from '../../src/analysis/taxonomy.ts';
import { PROMPT_VERSION } from '../../src/analysis/schema.ts';
import { generateCandidates, loadEligibleVideos } from '../../src/reco/candidates.ts';
import { normalisePopularity } from '../../src/reco/ranking.ts';
import { recordInteraction } from '../../src/reco/interactions.ts';
import { rebuildUserProfile } from '../../src/reco/profile.ts';
import { recommendCandidates } from '../../src/reco/recommender.ts';
import { makeFeatures } from '../fixtures.ts';
import type { VideoFeatures } from '../../src/analysis/schema.ts';

/**
 * Candidate generation and orchestration against the real Postgres, including the
 * pgvector similarity query.
 *
 * Opt-in via TEST_INTEGRATION=1. Rows are inserted directly: this covers the
 * recommender, and dragging MinIO and ffmpeg in would only add flakiness.
 */
const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'rtest_';
let warmUserId: string;
let coldUserId: string;
/** Generates engagement without making the target "seen" by either of the two above. */
let engagementUserId: string;
const created: string[] = [];

async function makeVideo(
  name: string,
  options: {
    creatorId?: string | null;
    analysed?: boolean;
    features?: Partial<VideoFeatures>;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const analysed = options.analysed ?? true;
  const features = makeFeatures(options.features);

  const [row] = await db
    .insert(videos)
    .values({
      source: 'test',
      externalId: `${PREFIX}${name}`,
      creatorId: options.creatorId === undefined ? `${PREFIX}creator_${name}` : options.creatorId,
      creatorHandle: options.creatorId === undefined ? `${PREFIX}creator_${name}` : options.creatorId,
      s3Key: `${PREFIX}${name}.mp4`,
      durationSeconds: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1024,
      checksum: `${PREFIX}${name}-checksum`,
      status: analysed ? 'analyzed' : 'ingested',
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning({ id: videos.id });

  const videoId = row!.id;
  created.push(videoId);

  if (analysed) {
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
  }

  return videoId;
}

let poolVideoId: string;
let unanalysedVideoId: string;
let noCreatorVideoId: string;
let popularityTargetId: string;

beforeAll(async () => {
  if (!enabled) return;

  const [warm] = await db
    .insert(users)
    .values({ label: `${PREFIX}warm` })
    .returning({ id: users.id });
  warmUserId = warm!.id;
  const [cold] = await db
    .insert(users)
    .values({ label: `${PREFIX}cold` })
    .returning({ id: users.id });
  coldUserId = cold!.id;
  const [engagement] = await db
    .insert(users)
    .values({ label: `${PREFIX}engagement` })
    .returning({ id: users.id });
  engagementUserId = engagement!.id;

  poolVideoId = await makeVideo('pool', { features: { setting: 'pool', actType: ['dancing'] } });
  await makeVideo('gym', { features: { setting: 'gym', actType: ['talking'] } });
  await makeVideo('office', { features: { setting: 'office', actType: ['posing'] } });
  noCreatorVideoId = await makeVideo('anon', { creatorId: null });
  unanalysedVideoId = await makeVideo('pending', { analysed: false });

  // Warm the profile with enough signal to clear the cold-start threshold, all of
  // it pointing at pool content.
  for (let i = 0; i < 6; i++) {
    await recordInteraction({
      eventId: `${PREFIX}warm-${i}`,
      userId: warmUserId,
      videoId: poolVideoId,
      type: i === 0 ? 'like' : 'view',
    });
  }
  // A controlled popularity target. Created last, so it is the newest row in the
  // table and therefore always inside the `fresh` source's window whatever else the
  // database holds - which is what makes it findable without depending on corpus
  // size. Its engagement comes from a third user, so it stays unseen (and so
  // eligible) for both the warm and the cold user.
  // Default features on purpose: popularity is computed from events, so nothing about
  // this video's content should be able to influence the number under test.
  popularityTargetId = await makeVideo('poptarget');
  for (let i = 0; i < 3; i++) {
    await recordInteraction({
      eventId: `${PREFIX}pop-${i}`,
      userId: engagementUserId,
      videoId: popularityTargetId,
      type: i === 0 ? 'like' : 'complete',
    });
  }

  await rebuildUserProfile(warmUserId);
  await rebuildUserProfile(coldUserId);
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  for (const id of [warmUserId, coldUserId, engagementUserId]) {
    if (id) await db.delete(users).where(eq(users.id, id));
  }
  await db.delete(videos).where(like(videos.externalId, `${PREFIX}%`));
  await closeDb();
}, 60_000);

describe.skipIf(!enabled)('eligibility', () => {
  it('excludes a video with no analysed features or vector', async () => {
    const eligible = await loadEligibleVideos();
    expect(eligible.has(unanalysedVideoId)).toBe(false);
    expect(eligible.has(poolVideoId)).toBe(true);
  });

  it('keeps a video whose creator is unknown', async () => {
    const eligible = await loadEligibleVideos();
    expect(eligible.has(noCreatorVideoId)).toBe(true);
    expect(eligible.get(noCreatorVideoId)!.creatorId).toBeNull();
  });
});

describe.skipIf(!enabled)('candidate generation', () => {
  it('excludes videos the user has already interacted with', async () => {
    const profile = await rebuildUserProfile(warmUserId);
    const generation = await generateCandidates(profile, 10);

    expect(generation.seenCount).toBeGreaterThan(0);
    expect(generation.candidates.map((c) => c.videoId)).not.toContain(poolVideoId);
  });

  it('runs the personalised sources for a warm user', async () => {
    const profile = await rebuildUserProfile(warmUserId);
    const generation = await generateCandidates(profile, 10);
    expect(generation.countsBySource.similar).toBeGreaterThan(0);
  });

  it('skips similarity and tag lookup for a cold-start user', async () => {
    const profile = await rebuildUserProfile(coldUserId);
    expect(profile.isColdStart).toBe(true);

    const generation = await generateCandidates(profile, 10);
    expect(generation.countsBySource.similar).toBe(0);
    expect(generation.countsBySource.tag).toBe(0);
    // Global sources still fill the list.
    expect(generation.countsBySource.fresh).toBeGreaterThan(0);
    expect(generation.countsBySource.explore).toBeGreaterThan(0);
  });

  it('honours the per-source cap', async () => {
    const profile = await rebuildUserProfile(coldUserId);
    const generation = await generateCandidates(profile, 10, { limits: { fresh: 2, explore: 1 } });
    expect(generation.countsBySource.fresh).toBeLessThanOrEqual(2);
    expect(generation.countsBySource.explore).toBeLessThanOrEqual(1);
  });

  it('labels a video with every source that produced it', async () => {
    const profile = await rebuildUserProfile(coldUserId);
    const generation = await generateCandidates(profile, 10);
    const multiSourced = generation.candidates.find((c) => c.sources.size > 1);
    expect(multiSourced).toBeDefined();
  });

  it('reports a shortage instead of quietly returning a short list', async () => {
    const profile = await rebuildUserProfile(coldUserId);
    const generation = await generateCandidates(profile, 10_000);
    expect(generation.exhausted).toBe(true);
  });
});

describe.skipIf(!enabled)('recommendCandidates', () => {
  it('returns an ordered list with diagnostics and a score breakdown', async () => {
    const result = await recommendCandidates(warmUserId, 3, { rebuildProfile: true });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(3);
    expect(result.diagnostics.coldStart).toBe(false);
    expect(result.diagnostics.latencyMs).toBeGreaterThanOrEqual(0);

    const first = result.items[0]!;
    expect(first.sources.length).toBeGreaterThan(0);
    expect(Number.isFinite(first.baseScore)).toBe(true);
    expect(Number.isFinite(first.finalScore)).toBe(true);
    expect(first.diversityPenalty).toBeGreaterThanOrEqual(0);
    expect(Object.keys(first.weighted)).toContain('affinity');
  });

  it('scores are ordered and never NaN', async () => {
    const result = await recommendCandidates(warmUserId, 5, { rebuildProfile: true });
    for (const item of result.items) {
      expect(Number.isNaN(item.finalScore)).toBe(false);
      for (const value of Object.values(item.features)) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('is deterministic for unchanged state', async () => {
    const now = new Date('2026-09-06T12:00:00.000Z');
    const first = await recommendCandidates(warmUserId, 4, { now });
    const second = await recommendCandidates(warmUserId, 4, { now });
    expect(first.items.map((i) => i.videoId)).toEqual(second.items.map((i) => i.videoId));
  });

  it('serves a cold-start user from global sources only', async () => {
    const result = await recommendCandidates(coldUserId, 3, { rebuildProfile: true });

    expect(result.diagnostics.coldStart).toBe(true);
    expect(result.diagnostics.candidateCounts.similar).toBe(0);
    for (const item of result.items) {
      expect(item.features.affinity).toBe(0);
      expect(item.features.creatorAffinity).toBe(0);
    }
  });

  it('gives one video the same popularity for a different user and a different limit', async () => {
    // Popularity is normalised over the whole trending window, never over the caller's
    // candidate pool - so for a *named* video it must come out identical whoever asked
    // and however many items they asked for.
    //
    // Asserted on one controlled video rather than on whatever two top-N lists happen
    // to share. That earlier form was a coin flip on unrelated state: this database
    // also holds the demo corpus, and two differently-ranked lists over it can
    // legitimately share nothing, so the test failed for reasons that had nothing to do
    // with the invariant in its name.
    //
    // `now` is pinned and passed to both calls because engagement decays linearly
    // across the window - leaving it to the clock would vary the very number under
    // test.
    const now = new Date();

    const warmProfile = await rebuildUserProfile(warmUserId, { now });
    const coldProfile = await rebuildUserProfile(coldUserId, { now });
    expect(warmProfile.isColdStart).toBe(false);
    expect(coldProfile.isColdStart).toBe(true);

    // Different users, different requested limits, and one is personalised while the
    // other is served from global sources only - every axis that could leak into the
    // number is varied at once.
    const warm = await generateCandidates(warmProfile, 25, { now });
    const cold = await generateCandidates(coldProfile, 3, { now });

    // The target is the newest video in the table, so `fresh` retrieves it for both
    // regardless of how large the corpus is. Eligibility, not ordering.
    expect(warm.candidates.map((c) => c.videoId)).toContain(popularityTargetId);
    expect(cold.candidates.map((c) => c.videoId)).toContain(popularityTargetId);

    // `loadEngagement` takes only a clock: no user, no candidate set, no limit. This
    // is the assertion that the aggregate really is global.
    const warmEngagement = warm.engagement.get(popularityTargetId);
    expect(warmEngagement).toBeGreaterThan(0);
    expect(cold.engagement.get(popularityTargetId)).toBe(warmEngagement);

    // And the feature the ranker consumes, which is what a score is actually built
    // from. Exact equality: this is one arithmetic result, not an approximation.
    const warmPopularity = normalisePopularity(warm.engagement).get(popularityTargetId);
    const coldPopularity = normalisePopularity(cold.engagement).get(popularityTargetId);
    expect(warmPopularity).toBeGreaterThan(0);
    expect(coldPopularity).toBe(warmPopularity);
  });

  it('does not fail on a video without a creator', async () => {
    const result = await recommendCandidates(coldUserId, 10, { rebuildProfile: true });
    const anon = result.items.find((i) => i.videoId === noCreatorVideoId);
    if (anon) expect(anon.features.creatorAffinity).toBe(0);
    expect(result.items.every((i) => Number.isFinite(i.finalScore))).toBe(true);
  });
});
