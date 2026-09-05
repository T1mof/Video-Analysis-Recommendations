import { describe, expect, it } from 'vitest';
import {
  FATIGUE_RECENT_VIDEOS,
  FRESHNESS_HALFLIFE_HOURS,
  fatigue,
  freshness,
  normalisePopularity,
  rankCandidates,
  scoreCandidate,
  sortDeterministically,
  tagAffinity,
  type UserRankingContext,
} from '../../src/reco/ranking.ts';
import type { Candidate, EligibleVideo } from '../../src/reco/candidates.ts';
import { encodeFeatures } from '../../src/analysis/embedding.ts';
import { slotIndex, TAXONOMY_DIM } from '../../src/analysis/taxonomy.ts';
import { env } from '../../src/config/env.ts';
import { makeFeatures } from '../fixtures.ts';
import type { VideoFeatures } from '../../src/analysis/schema.ts';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const HOUR = 3_600_000;

function video(
  id: string,
  overrides: Partial<VideoFeatures> = {},
  extra: Partial<EligibleVideo> = {},
): EligibleVideo {
  const features = makeFeatures(overrides);
  return {
    videoId: id,
    creatorId: `creator_${id}`,
    creatorHandle: `creator_${id}`,
    externalId: id,
    createdAt: NOW,
    vector: encodeFeatures(features),
    features,
    ...extra,
  };
}

function candidate(id: string): Candidate {
  return { videoId: id, sources: new Set(['similar']) };
}

function context(overrides: Partial<UserRankingContext> = {}): UserRankingContext {
  return {
    userId: 'user-1',
    profileVector: new Array<number>(TAXONOMY_DIM).fill(0),
    isColdStart: false,
    creatorAffinity: new Map(),
    recentVideos: [],
    now: NOW,
    explorationBucket: '2026-09-06',
    ...overrides,
  };
}

/** A profile that likes exactly one tag, so its effect is isolatable. */
function profileLiking(field: Parameters<typeof slotIndex>[0], value: string, weight = 0.5) {
  const vector = new Array<number>(TAXONOMY_DIM).fill(0);
  vector[slotIndex(field, value)!] = weight;
  return vector;
}

describe('freshness', () => {
  it('halves every half-life and stays in [0,1]', () => {
    expect(freshness(NOW, NOW)).toBeCloseTo(1, 10);
    expect(freshness(new Date(NOW.getTime() - FRESHNESS_HALFLIFE_HOURS * HOUR), NOW)).toBeCloseTo(
      0.5,
      10,
    );
    expect(
      freshness(new Date(NOW.getTime() - 2 * FRESHNESS_HALFLIFE_HOURS * HOUR), NOW),
    ).toBeCloseTo(0.25, 10);
  });

  it('ranks a newer video at or above an older one', () => {
    const older = freshness(new Date(NOW.getTime() - 200 * HOUR), NOW);
    const newer = freshness(new Date(NOW.getTime() - 2 * HOUR), NOW);
    expect(newer).toBeGreaterThan(older);
  });

  it('treats a future timestamp as brand new rather than exceeding 1', () => {
    expect(freshness(new Date(NOW.getTime() + 100 * HOUR), NOW)).toBe(1);
  });
});

describe('normalisePopularity', () => {
  it('scales against the strongest positive engagement', () => {
    const result = normalisePopularity(
      new Map([
        ['a', 0],
        ['b', 5],
        ['c', 10],
      ]),
    );
    expect(result.get('a')).toBe(0);
    expect(result.get('c')).toBe(1);
    expect(result.get('b')).toBeCloseTo(0.5, 10);
  });

  it('treats equally engaged videos as equally popular, without NaN', () => {
    const result = normalisePopularity(
      new Map([
        ['a', 3],
        ['b', 3],
      ]),
    );
    // A constant cannot change the ordering; what matters is that it is finite.
    expect(result.get('a')).toBe(result.get('b'));
    expect([...result.values()].every(Number.isFinite)).toBe(true);
  });

  it('never promotes negative engagement', () => {
    // The failure this guards: min-max over signed values would map the least
    // skipped video to 1.0 and call it the most popular thing in the catalogue.
    const result = normalisePopularity(
      new Map([
        ['skipped_less', -0.5],
        ['skipped_more', -1],
      ]),
    );
    expect(result.get('skipped_less')).toBe(0);
    expect(result.get('skipped_more')).toBe(0);
  });

  it('keeps a positively engaged video above a negatively engaged one', () => {
    const result = normalisePopularity(
      new Map([
        ['liked', 2],
        ['skipped', -2],
      ]),
    );
    expect(result.get('liked')).toBe(1);
    expect(result.get('skipped')).toBe(0);
  });

  it('handles a single engaged video and an empty map', () => {
    expect(normalisePopularity(new Map([['a', 7]])).get('a')).toBe(1);
    expect(normalisePopularity(new Map([['a', -7]])).get('a')).toBe(0);
    expect(normalisePopularity(new Map()).size).toBe(0);
  });

  it('reads a video with no engagement at all as zero', () => {
    const result = normalisePopularity(new Map([['engaged', 4]]));
    expect(result.get('never_watched') ?? 0).toBe(0);
  });

  it('keeps a more-engaged video above a less-engaged one', () => {
    const result = normalisePopularity(
      new Map([
        ['low', 1],
        ['high', 9],
      ]),
    );
    expect(result.get('high')!).toBeGreaterThan(result.get('low')!);
  });

  it('gives a video the same score regardless of who is asking or how many are requested', () => {
    // Popularity is normalised over the whole trending window, so it must not move
    // when a different user's candidate pool happens to contain other videos.
    const universe = new Map([
      ['target', 4],
      ['other_1', 10],
      ['other_2', 1],
    ]);
    const forUserA = normalisePopularity(universe);
    const forUserB = normalisePopularity(universe);

    expect(forUserA.get('target')).toBe(forUserB.get('target'));
    expect(forUserA.get('target')).toBeCloseTo(0.4, 10);
  });
});

describe('tagAffinity', () => {
  it('is positive for a video carrying a preferred tag', () => {
    const profile = profileLiking('setting', 'pool', 0.6);
    expect(tagAffinity(profile, video('v1', { setting: 'pool' }))).toBeGreaterThan(0);
  });

  it('is negative for a video carrying a disliked tag', () => {
    const profile = profileLiking('setting', 'pool', -0.6);
    expect(tagAffinity(profile, video('v1', { setting: 'pool' }))).toBeLessThan(0);
  });

  it('is zero against an empty profile', () => {
    expect(tagAffinity(new Array<number>(TAXONOMY_DIM).fill(0), video('v1'))).toBe(0);
  });

  it('ignores unknown and none, which are not preferences', () => {
    const profile = new Array<number>(TAXONOMY_DIM).fill(0);
    profile[slotIndex('hairColor', 'unknown')!] = 1;
    profile[slotIndex('penetrationType', 'none')!] = 1;
    expect(
      tagAffinity(profile, video('v1', { hairColor: 'unknown', penetrationType: 'none' })),
    ).toBe(0);
  });
});

describe('fatigue', () => {
  it('is zero with no history', () => {
    expect(fatigue(video('v1'), [])).toBe(0);
  });

  it('rises when the same creator dominates recent history', () => {
    const recent = Array.from({ length: FATIGUE_RECENT_VIDEOS }, (_, i) =>
      video(`r${i}`, {}, { creatorId: 'creator_v1' }),
    );
    expect(fatigue(video('v1'), recent)).toBeCloseTo(1, 10);
  });

  it('rises when a meaningful tag dominates recent history', () => {
    const recent = Array.from({ length: FATIGUE_RECENT_VIDEOS }, (_, i) =>
      video(`r${i}`, { setting: 'pool' }, { creatorId: `other_${i}` }),
    );
    const candidateVideo = video('v1', { setting: 'pool' }, { creatorId: 'unique' });
    expect(fatigue(candidateVideo, recent)).toBeGreaterThan(0.9);
  });

  it('is discounted while the history window is barely populated', () => {
    const few = [video('r1', {}, { creatorId: 'creator_v1' })];
    const many = Array.from({ length: FATIGUE_RECENT_VIDEOS }, (_, i) =>
      video(`r${i}`, {}, { creatorId: 'creator_v1' }),
    );
    // Same 100% frequency, very different confidence in it.
    expect(fatigue(video('v1'), few)).toBeLessThan(fatigue(video('v1'), many));
  });

  it('stays within [0,1]', () => {
    const recent = Array.from({ length: FATIGUE_RECENT_VIDEOS }, (_, i) =>
      video(`r${i}`, {}, { creatorId: 'creator_v1' }),
    );
    const value = fatigue(video('v1'), recent);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe('scoreCandidate', () => {
  it('matches the weighted formula exactly', () => {
    const v = video('v1', { setting: 'pool' });
    const ctx = context({ profileVector: profileLiking('setting', 'pool', 0.4) });
    const scored = scoreCandidate(candidate('v1'), v, ctx, new Map([['v1', 0.5]]));

    const f = scored.features;
    const expected =
      env.RANK_W_AFFINITY * f.affinity +
      env.RANK_W_QUALITY * f.quality +
      env.RANK_W_FRESHNESS * f.freshness +
      env.RANK_W_POPULARITY * f.popularity -
      env.RANK_W_FATIGUE * f.fatigue +
      env.RANK_W_EXPLORATION * f.exploration +
      env.RANK_W_CREATOR_AFFINITY * f.creatorAffinity;

    expect(scored.baseScore).toBeCloseTo(expected, 12);
  });

  it('averages content similarity and tag affinity into affinity', () => {
    const v = video('v1', { setting: 'pool' });
    const ctx = context({ profileVector: profileLiking('setting', 'pool', 0.4) });
    const { features } = scoreCandidate(candidate('v1'), v, ctx, new Map());
    expect(features.affinity).toBeCloseTo(
      (features.contentSimilarity + features.tagAffinity) / 2,
      12,
    );
  });

  it('lifts the score for a liked creator and lowers it for a disliked one', () => {
    const v = video('v1');
    const liked = scoreCandidate(
      candidate('v1'),
      v,
      context({ creatorAffinity: new Map([['creator_v1', 0.8]]) }),
      new Map(),
    );
    const disliked = scoreCandidate(
      candidate('v1'),
      v,
      context({ creatorAffinity: new Map([['creator_v1', -0.8]]) }),
      new Map(),
    );
    expect(liked.baseScore).toBeGreaterThan(disliked.baseScore);
    expect(liked.features.creatorAffinity).toBeGreaterThan(0);
    expect(disliked.features.creatorAffinity).toBeLessThan(0);
  });

  it('scores a video with no creator without failing, at zero creator affinity', () => {
    const v = video('v1', {}, { creatorId: null, creatorHandle: null });
    const scored = scoreCandidate(
      candidate('v1'),
      v,
      context({ creatorAffinity: new Map([['creator_v1', 0.9]]) }),
      new Map(),
    );
    expect(scored.features.creatorAffinity).toBe(0);
    expect(Number.isFinite(scored.baseScore)).toBe(true);
  });

  it('zeroes the personalised terms for a cold-start user', () => {
    const v = video('v1', { setting: 'pool' });
    const scored = scoreCandidate(
      candidate('v1'),
      v,
      context({
        isColdStart: true,
        profileVector: profileLiking('setting', 'pool', 0.9),
        creatorAffinity: new Map([['creator_v1', 0.9]]),
      }),
      new Map(),
    );
    expect(scored.features.affinity).toBe(0);
    expect(scored.features.contentSimilarity).toBe(0);
    expect(scored.features.tagAffinity).toBe(0);
    expect(scored.features.creatorAffinity).toBe(0);
    // Global signals still apply.
    expect(scored.features.freshness).toBeGreaterThan(0);
  });

  it('reports quality as unavailable rather than inventing one', () => {
    const v = video('v1');
    (v.features as { aestheticScore: unknown }).aestheticScore = undefined;
    const scored = scoreCandidate(candidate('v1'), v, context(), new Map());

    expect(scored.features.qualityAvailable).toBe(false);
    expect(scored.features.quality).toBe(0);
    expect(scored.weighted.quality).toBe(0);
    expect(Number.isFinite(scored.baseScore)).toBe(true);
  });

  it('produces only finite feature values', () => {
    const v = video('v1', {}, { vector: new Array<number>(TAXONOMY_DIM).fill(0) });
    const scored = scoreCandidate(candidate('v1'), v, context(), new Map());
    for (const [name, value] of Object.entries(scored.features)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
      }
    }
    expect(Number.isFinite(scored.baseScore)).toBe(true);
  });

  it('gives the same exploration value for the same user, video and bucket', () => {
    const v = video('v1');
    const a = scoreCandidate(candidate('v1'), v, context(), new Map());
    const b = scoreCandidate(candidate('v1'), v, context(), new Map());
    expect(a.features.exploration).toBe(b.features.exploration);

    const other = scoreCandidate(
      candidate('v1'),
      v,
      context({ explorationBucket: '2026-09-07' }),
      new Map(),
    );
    expect(other.features.exploration).not.toBe(a.features.exploration);
  });
});

describe('deterministic ordering', () => {
  it('breaks score ties by video id', () => {
    const items = [{ videoId: 'b' }, { videoId: 'a' }, { videoId: 'c' }];
    const sorted = sortDeterministically(items, () => 1);
    expect(sorted.map((i) => i.videoId)).toEqual(['a', 'b', 'c']);
  });

  it('returns the same order across repeated ranking calls', () => {
    const eligible = new Map([
      ['v1', video('v1')],
      ['v2', video('v2')],
      ['v3', video('v3')],
    ]);
    const candidates = ['v1', 'v2', 'v3'].map(candidate);
    const ctx = context();

    const first = rankCandidates(candidates, eligible, ctx, new Map());
    const second = rankCandidates(candidates, eligible, ctx, new Map());
    expect(first.map((c) => c.videoId)).toEqual(second.map((c) => c.videoId));
  });

  it('drops candidates that are no longer eligible instead of scoring undefined', () => {
    const eligible = new Map([['v1', video('v1')]]);
    const ranked = rankCandidates([candidate('v1'), candidate('missing')], eligible, context(), new Map());
    expect(ranked.map((c) => c.videoId)).toEqual(['v1']);
  });
});
