import { describe, expect, it } from 'vitest';
import { diversifyCandidates } from '../../src/reco/diversity.ts';
import { diversityTags } from '../../src/reco/diversityTags.ts';
import type { ScoredCandidate } from '../../src/reco/ranking.ts';
import type { EligibleVideo } from '../../src/reco/candidates.ts';
import { encodeFeatures } from '../../src/analysis/embedding.ts';
import { makeFeatures } from '../fixtures.ts';
import type { VideoFeatures } from '../../src/analysis/schema.ts';

const NOW = new Date('2026-09-06T12:00:00.000Z');

function video(
  id: string,
  overrides: Partial<VideoFeatures> = {},
  creatorId: string | null = `creator_${id}`,
): EligibleVideo {
  const features = makeFeatures(overrides);
  return {
    videoId: id,
    creatorId,
    creatorHandle: creatorId,
    externalId: id,
    createdAt: NOW,
    vector: encodeFeatures(features),
    features,
  };
}

/**
 * A video that differs from its neighbours across *every* diversity field.
 *
 * `makeFeatures` returns one fixed video, so fixtures that override a single field
 * still collide on hairColor, cameraStyle, sexPosition and the rest - and the tag
 * cap would fire before the rule under test ever got a chance.
 */
const SETTINGS = ['bedroom', 'pool', 'outdoor', 'studio', 'gym', 'office', 'car'] as const;
const ACTS = ['posing', 'dancing', 'talking', 'oral', 'massage', 'toy_use', 'manual'] as const;
const HAIR = ['blonde', 'dark', 'red', 'colored'] as const;
const CAMERA = ['standard', 'pov', 'selfie', 'mixed'] as const;
const POSITIONS = ['riding', 'missionary', 'doggy', 'standing', 'side'] as const;

function variedVideo(id: string, index: number, creatorId: string | null): EligibleVideo {
  return video(
    id,
    {
      setting: SETTINGS[index % SETTINGS.length],
      actType: [ACTS[index % ACTS.length]!],
      hairColor: HAIR[index % HAIR.length],
      cameraStyle: CAMERA[index % CAMERA.length],
      sexPosition: POSITIONS[index % POSITIONS.length],
      fetishTags: [],
    },
    creatorId,
  );
}

function scored(videoId: string, baseScore: number): ScoredCandidate {
  return {
    videoId,
    sources: ['similar'],
    features: {
      contentSimilarity: 0,
      tagAffinity: 0,
      affinity: 0,
      creatorAffinity: 0,
      popularity: 0,
      freshness: 0,
      fatigue: 0,
      exploration: 0,
      quality: 0,
      qualityAvailable: true,
    },
    weighted: {},
    baseScore,
  };
}

function build(videos: EligibleVideo[]): Map<string, EligibleVideo> {
  return new Map(videos.map((v) => [v.videoId, v]));
}

const OPTIONS = { lambda: 0.3, maxSameCreator: 2, maxSameTagInTop10: 3 };

describe('creator cap', () => {
  it('does not let one creator take more than the cap while alternatives exist', () => {
    const videos = [
      variedVideo('a1', 0, 'hoarder'),
      variedVideo('a2', 1, 'hoarder'),
      variedVideo('a3', 2, 'hoarder'),
      variedVideo('b1', 3, 'other_1'),
      variedVideo('b2', 4, 'other_2'),
    ];
    const ranked = [
      scored('a1', 1.0),
      scored('a2', 0.9),
      scored('a3', 0.8),
      scored('b1', 0.1),
      scored('b2', 0.05),
    ];

    const result = diversifyCandidates(ranked, build(videos), 4, OPTIONS);
    const hoarderCount = result.selected.filter(
      (item) => build(videos).get(item.videoId)!.creatorId === 'hoarder',
    ).length;

    expect(hoarderCount).toBe(2);
    expect(result.selected).toHaveLength(4);
    expect(result.diversityRelaxed).toBe(false);
  });

  it('does not treat several null creators as one shared creator', () => {
    const videos = ['n1', 'n2', 'n3', 'n4'].map((id, i) => variedVideo(id, i, null));
    const ranked = videos.map((v, i) => scored(v.videoId, 1 - i * 0.1));

    const result = diversifyCandidates(ranked, build(videos), 4, OPTIONS);
    expect(result.selected).toHaveLength(4);
    expect(result.diversityRelaxed).toBe(false);
  });
});

describe('tag cap in the top window', () => {
  it('limits how often one meaningful tag repeats while alternatives exist', () => {
    // Five videos that all share setting:pool, and five that differ on every field.
    const repeated = ['t1', 't2', 't3', 't4', 't5'].map((id, i) => {
      const v = variedVideo(id, i, `creator_${id}`);
      v.features.setting = 'pool';
      v.vector = encodeFeatures(v.features);
      return v;
    });
    const varied = ['v1', 'v2', 'v3', 'v4', 'v5'].map((id, i) =>
      variedVideo(id, i + 1, `creator_${id}`),
    );
    const videos = [...repeated, ...varied];
    const ranked = [
      ...repeated.map((v, i) => scored(v.videoId, 1 - i * 0.01)),
      ...varied.map((v, i) => scored(v.videoId, 0.5 - i * 0.01)),
    ];

    // Six of ten requested: asking for the whole corpus would force the caps to
    // relax by construction, which is the fallback's job, not the cap's failure.
    const result = diversifyCandidates(ranked, build(videos), 6, OPTIONS);
    const map = build(videos);
    const poolCount = result.selected.filter((item) =>
      diversityTags(map.get(item.videoId)!.features).includes('setting:pool'),
    ).length;

    expect(result.selected).toHaveLength(6);
    expect(poolCount).toBeLessThanOrEqual(OPTIONS.maxSameTagInTop10);
    expect(result.diversityRelaxed).toBe(false);
  });

  it('must relax when the requested limit needs the whole corpus', () => {
    // Ten near-identical videos, ten requested: no selection can honour the cap, so
    // a full list is the right answer and the relaxation is reported.
    const videos = Array.from({ length: 10 }, (_, i) =>
      video(`same${i}`, { setting: 'pool', actType: ['posing'] }, `creator_${i}`),
    );
    const ranked = videos.map((v, i) => scored(v.videoId, 1 - i * 0.01));

    const result = diversifyCandidates(ranked, build(videos), 10, OPTIONS);
    expect(result.selected).toHaveLength(10);
    expect(result.diversityRelaxed).toBe(true);
  });
});

describe('similarity penalty', () => {
  it('leaves the first selection unpenalised', () => {
    const videos = [video('a'), video('b')];
    const result = diversifyCandidates([scored('a', 1), scored('b', 0.9)], build(videos), 2, OPTIONS);
    expect(result.selected[0]!.diversityPenalty).toBe(0);
    expect(result.selected[0]!.finalScore).toBe(result.selected[0]!.baseScore);
  });

  it('penalises a near-duplicate of an already selected item', () => {
    const twin = (): Partial<VideoFeatures> => ({ setting: 'pool', actType: ['posing'] });
    const videos = [
      video('x1', twin(), 'c1'),
      video('x2', twin(), 'c2'),
      video('different', { setting: 'gym', actType: ['talking'] }, 'c3'),
    ];
    const ranked = [scored('x1', 1.0), scored('x2', 0.95), scored('different', 0.9)];

    const result = diversifyCandidates(ranked, build(videos), 3, OPTIONS);
    const byId = new Map(result.selected.map((item) => [item.videoId, item]));

    expect(byId.get('x2')!.diversityPenalty).toBeGreaterThan(0);
    // The near-duplicate loses ground to the diverse alternative despite scoring higher.
    expect(result.selected[1]!.videoId).toBe('different');
  });

  it('produces a finite penalty for a zero vector', () => {
    const zeroVideo = video('z');
    zeroVideo.vector = new Array<number>(zeroVideo.vector.length).fill(0);
    const videos = [video('a'), zeroVideo];
    const result = diversifyCandidates([scored('a', 1), scored('z', 0.9)], build(videos), 2, OPTIONS);
    expect(result.selected.every((item) => Number.isFinite(item.finalScore))).toBe(true);
  });
});

describe('small-corpus fallback', () => {
  it('fills the list by relaxing the caps rather than returning a short one', () => {
    // Four videos, all one creator: the cap alone would allow only two.
    const videos = ['a', 'b', 'c', 'd'].map((id) => video(id, {}, 'only_creator'));
    const ranked = videos.map((v, i) => scored(v.videoId, 1 - i * 0.1));

    const result = diversifyCandidates(ranked, build(videos), 4, OPTIONS);

    expect(result.selected).toHaveLength(4);
    expect(result.diversityRelaxed).toBe(true);
    expect(result.relaxedCount).toBe(2);
    expect(result.selected.filter((i) => i.admittedByRelaxation)).toHaveLength(2);
  });

  it('marks nothing as relaxed when the constraints were satisfiable', () => {
    const videos = ['a', 'b'].map((id) => video(id, {}, `creator_${id}`));
    const result = diversifyCandidates(
      [scored('a', 1), scored('b', 0.5)],
      build(videos),
      2,
      OPTIONS,
    );
    expect(result.diversityRelaxed).toBe(false);
    expect(result.relaxedCount).toBe(0);
  });

  it('returns everything available when fewer candidates exist than requested', () => {
    const videos = [video('a')];
    const result = diversifyCandidates([scored('a', 1)], build(videos), 10, OPTIONS);
    expect(result.selected).toHaveLength(1);
    expect(result.diversityRelaxed).toBe(false);
  });

  it('relaxes in score order, so the tail is the best of what was excluded', () => {
    const videos = ['a', 'b', 'c', 'd'].map((id) => video(id, {}, 'only_creator'));
    const ranked = [scored('a', 1.0), scored('b', 0.9), scored('c', 0.8), scored('d', 0.7)];
    const result = diversifyCandidates(ranked, build(videos), 4, OPTIONS);
    const relaxed = result.selected.filter((i) => i.admittedByRelaxation).map((i) => i.videoId);
    expect(relaxed).toEqual(['c', 'd']);
  });
});

describe('determinism', () => {
  it('produces the same list on repeated calls', () => {
    const videos = ['a', 'b', 'c', 'd', 'e'].map((id) => video(id, {}, `creator_${id}`));
    const ranked = videos.map((v) => scored(v.videoId, 0.5));
    const eligible = build(videos);

    const first = diversifyCandidates(ranked, eligible, 5, OPTIONS);
    const second = diversifyCandidates(ranked, eligible, 5, OPTIONS);
    expect(first.selected.map((i) => i.videoId)).toEqual(second.selected.map((i) => i.videoId));
  });
});
