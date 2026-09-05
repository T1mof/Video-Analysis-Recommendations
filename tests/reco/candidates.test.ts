import { describe, expect, it } from 'vitest';
import {
  explorationBucket,
  explorationScore,
  topPreferredTags,
  unionCandidates,
  type EligibleVideo,
} from '../../src/reco/candidates.ts';
import {
  DIVERSITY_TAG_FIELDS,
  assertDiversityPolicyCoversTaxonomy,
  diversityTags,
} from '../../src/reco/diversityTags.ts';
import { encodeFeatures } from '../../src/analysis/embedding.ts';
import { TAXONOMY_DIM, slotIndex } from '../../src/analysis/taxonomy.ts';
import type { UserProfile } from '../../src/reco/profile.ts';
import { makeFeatures } from '../fixtures.ts';

function video(id: string): EligibleVideo {
  const features = makeFeatures();
  return {
    videoId: id,
    creatorId: `creator_${id}`,
    creatorHandle: `creator_${id}`,
    externalId: id,
    createdAt: new Date('2026-09-06T12:00:00.000Z'),
    vector: encodeFeatures(features),
    features,
  };
}

function profile(vector: number[], overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    userId: 'user-1',
    taxonomyVersion: 2,
    vector,
    interactionCount: 10,
    effectiveSignalCount: 10,
    positiveSignal: 5,
    negativeSignal: 1,
    skippedNoFeatures: 0,
    isColdStart: false,
    creatorAffinity: [],
    ...overrides,
  };
}

describe('unionCandidates', () => {
  const eligible = new Map([
    ['v1', video('v1')],
    ['v2', video('v2')],
    ['v3', video('v3')],
  ]);

  it('returns a video once but remembers every source that produced it', () => {
    const merged = unionCandidates(
      {
        similar: ['v1', 'v2'],
        tag: ['v1'],
        trending: ['v1', 'v3'],
        fresh: [],
        explore: [],
      },
      eligible,
    );

    expect(merged).toHaveLength(3);
    const v1 = merged.find((c) => c.videoId === 'v1')!;
    expect([...v1.sources].sort()).toEqual(['similar', 'tag', 'trending']);
    expect([...merged.find((c) => c.videoId === 'v2')!.sources]).toEqual(['similar']);
  });

  it('drops anything a source returned that is not eligible', () => {
    const merged = unionCandidates({ similar: ['v1', 'ghost'] }, eligible);
    expect(merged.map((c) => c.videoId)).toEqual(['v1']);
  });

  it('returns nothing when every source is empty', () => {
    expect(unionCandidates({}, eligible)).toHaveLength(0);
  });
});

describe('topPreferredTags', () => {
  it('returns the strongest positive preferences, strongest first', () => {
    const vector = new Array<number>(TAXONOMY_DIM).fill(0);
    vector[slotIndex('setting', 'pool')!] = 0.4;
    vector[slotIndex('hairColor', 'blonde')!] = 0.9;

    const tags = topPreferredTags(profile(vector));
    expect(tags[0]).toMatchObject({ field: 'hairColor', value: 'blonde' });
    expect(tags[1]).toMatchObject({ field: 'setting', value: 'pool' });
  });

  it('ignores negative dimensions - a dislike is not something to retrieve on', () => {
    const vector = new Array<number>(TAXONOMY_DIM).fill(0);
    vector[slotIndex('setting', 'pool')!] = -0.9;
    expect(topPreferredTags(profile(vector))).toHaveLength(0);
  });

  it('never proposes unknown or none as a preference', () => {
    const vector = new Array<number>(TAXONOMY_DIM).fill(0);
    vector[slotIndex('hairColor', 'unknown')!] = 0.9;
    vector[slotIndex('penetrationType', 'none')!] = 0.8;
    expect(topPreferredTags(profile(vector))).toHaveLength(0);
  });

  it('respects the requested count', () => {
    const vector = new Array<number>(TAXONOMY_DIM).fill(0.1);
    expect(topPreferredTags(profile(vector), 3)).toHaveLength(3);
  });
});

describe('exploration', () => {
  it('is deterministic for the same user, video and bucket', () => {
    expect(explorationScore('u1', 'v1', '2026-09-06')).toBe(
      explorationScore('u1', 'v1', '2026-09-06'),
    );
  });

  it('differs across users, videos and days', () => {
    const base = explorationScore('u1', 'v1', '2026-09-06');
    expect(explorationScore('u2', 'v1', '2026-09-06')).not.toBe(base);
    expect(explorationScore('u1', 'v2', '2026-09-06')).not.toBe(base);
    expect(explorationScore('u1', 'v1', '2026-09-07')).not.toBe(base);
  });

  it('stays within [0,1)', () => {
    for (let i = 0; i < 200; i++) {
      const score = explorationScore('u1', `v${i}`, '2026-09-06');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(1);
    }
  });

  it('buckets by UTC day', () => {
    expect(explorationBucket(new Date('2026-09-06T23:59:59.000Z'))).toBe('2026-09-06');
    expect(explorationBucket(new Date('2026-09-07T00:00:01.000Z'))).toBe('2026-09-07');
  });
});

describe('diversity tag policy', () => {
  it('classifies every taxonomy field as either a diversity tag or excluded', () => {
    expect(() => assertDiversityPolicyCoversTaxonomy()).not.toThrow();
  });

  it('emits only fields from the diversity set', () => {
    const tags = diversityTags(makeFeatures());
    for (const tag of tags) {
      const field = tag.split(':')[0]!;
      expect(DIVERSITY_TAG_FIELDS).toContain(field);
    }
  });

  it('excludes unknown and none, which do not describe content', () => {
    const tags = diversityTags(
      makeFeatures({ hairColor: 'unknown', penetrationType: 'none', sexPosition: 'none' }),
    );
    expect(tags).not.toContain('hairColor:unknown');
    expect(tags).not.toContain('penetrationType:none');
    expect(tags).not.toContain('sexPosition:none');
  });

  it('excludes the near-constant fields that would block the whole feed', () => {
    const tags = diversityTags(makeFeatures());
    const fields = tags.map((t) => t.split(':')[0]);
    expect(fields).not.toContain('performerGender');
    expect(fields).not.toContain('explicitness');
    expect(fields).not.toContain('mediaType');
  });

  it('lists each multi-value tag once even if the model repeated it', () => {
    const tags = diversityTags(makeFeatures({ actType: ['posing', 'posing'] }));
    expect(tags.filter((t) => t === 'actType:posing')).toHaveLength(1);
  });
});
