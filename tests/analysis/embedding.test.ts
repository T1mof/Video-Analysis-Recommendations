import { describe, expect, it } from 'vitest';
import {
  cosine,
  encodeFeatures,
  explainSimilarity,
  normalize,
  toTagAffinity,
  topDimensions,
} from '../../src/analysis/embedding.ts';
import { TAXONOMY_DIM, TAXONOMY_LAYOUT, slotIndex } from '../../src/analysis/taxonomy.ts';
import { makeFeatures } from '../fixtures.ts';

describe('encodeFeatures', () => {
  it('produces a unit vector of the declared dimension', () => {
    const vec = encodeFeatures(makeFeatures());
    expect(vec).toHaveLength(TAXONOMY_DIM);
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('is deterministic', () => {
    expect(encodeFeatures(makeFeatures())).toEqual(encodeFeatures(makeFeatures()));
  });

  it('lights up the slot matching a tag and leaves others dark', () => {
    const vec = encodeFeatures(makeFeatures({ hairColor: 'blonde' }));
    expect(vec[slotIndex('hairColor', 'blonde')!]).toBeGreaterThan(0);
    expect(vec[slotIndex('hairColor', 'red')!]).toBe(0);
  });

  it('scores videos sharing tags above videos sharing none', () => {
    const a = encodeFeatures(makeFeatures());
    const similar = encodeFeatures(makeFeatures({ productionQuality: 'semi_pro' }));
    const different = encodeFeatures(
      makeFeatures({
        hairColor: 'dark',
        setting: 'outdoor',
        clothing: 'swimwear',
        actType: ['dancing'],
        fetishTags: ['public'],
        performerCount: 'duo',
        appearanceFeatures: [],
      }),
    );

    expect(cosine(a, similar)).toBeGreaterThan(cosine(a, different));
  });

  it('weights a tag down when the model reports low confidence', () => {
    const confident = encodeFeatures(makeFeatures({ confidence: { hairColor: 1.0 } }));
    const unsure = encodeFeatures(makeFeatures({ confidence: { hairColor: 0.1 } }));
    const blonde = slotIndex('hairColor', 'blonde')!;
    expect(confident[blonde]!).toBeGreaterThan(unsure[blonde]!);
  });

  it("splits a field's weight across multiple selected values", () => {
    const one = encodeFeatures(makeFeatures({ actType: ['posing'] }));
    const many = encodeFeatures(makeFeatures({ actType: ['posing', 'dancing', 'undressing'] }));
    const posing = slotIndex('actType', 'posing')!;
    // A video tagged with three acts must not outweigh one tagged with a single act.
    expect(many[posing]!).toBeLessThan(one[posing]!);
  });

  it('ignores duplicates within a multi-value field', () => {
    const clean = encodeFeatures(makeFeatures({ actType: ['posing'] }));
    const duplicated = encodeFeatures(makeFeatures({ actType: ['posing', 'posing'] }));
    expect(duplicated).toEqual(clean);
  });

  it('carries content only - ranking-stage signals do not enter the vector', () => {
    // Two videos with identical tags but wildly different aesthetic scores are
    // content-identical. Quality/freshness/popularity are scored in rank.ts, so
    // their weights can change without re-encoding vectors or rebuilding HNSW.
    const dull = encodeFeatures(makeFeatures({ aestheticScore: 0.05 }));
    const stunning = encodeFeatures(makeFeatures({ aestheticScore: 0.99 }));
    expect(dull).toEqual(stunning);
    expect(cosine(dull, stunning)).toBeCloseTo(1, 10);
  });

  it('empty multi-value fields contribute nothing', () => {
    const vec = encodeFeatures(makeFeatures({ fetishTags: [], appearanceFeatures: [] }));
    expect(vec[slotIndex('fetishTags', 'stockings')!]).toBe(0);
    expect(vec[slotIndex('appearanceFeatures', 'tattoos')!]).toBe(0);
  });
});

describe('unknown handling', () => {
  it('encodes "unknown" as zero rather than as a shared trait', () => {
    const vec = encodeFeatures(makeFeatures({ hairColor: 'unknown' }));
    expect(vec[slotIndex('hairColor', 'unknown')!]).toBe(0);
  });

  it('does not make two undeterminable videos look similar', () => {
    // Both videos have unknown hair AND unknown body type, and differ everywhere
    // else. If `unknown` matched `unknown` they would score as related.
    const a = encodeFeatures(
      makeFeatures({
        hairColor: 'unknown',
        bodyType: 'unknown',
        setting: 'bedroom',
        actType: ['posing'],
        fetishTags: ['stockings'],
        appearanceFeatures: [],
      }),
    );
    const b = encodeFeatures(
      makeFeatures({
        hairColor: 'unknown',
        bodyType: 'unknown',
        setting: 'gym',
        actType: ['dancing'],
        fetishTags: ['public'],
        appearanceFeatures: [],
        performerCount: 'group',
        performerGender: 'mixed',
        clothing: 'casual',
        explicitness: 'sfw',
      }),
    );

    for (const tag of ['hairColor:unknown', 'bodyType:unknown']) {
      const index = TAXONOMY_LAYOUT.indexOf(tag as (typeof TAXONOMY_LAYOUT)[number]);
      expect(a[index]).toBe(0);
      expect(b[index]).toBe(0);
    }
    expect(explainSimilarity(a, b).map((c) => c.dimension)).not.toContain('hairColor:unknown');
  });

  it('still encodes "none" and "other" - they are real observations', () => {
    const vec = encodeFeatures(makeFeatures({ sexPosition: 'none', setting: 'other' }));
    expect(vec[slotIndex('sexPosition', 'none')!]).toBeGreaterThan(0);
    expect(vec[slotIndex('setting', 'other')!]).toBeGreaterThan(0);
  });

  it('zeroes productionQuality:unknown like every other unknown', () => {
    const unknown = encodeFeatures(makeFeatures({ productionQuality: 'unknown' }));
    expect(unknown[slotIndex('productionQuality', 'unknown')!]).toBe(0);
    expect(unknown[slotIndex('productionQuality', 'amateur')!]).toBe(0);

    const known = encodeFeatures(makeFeatures({ productionQuality: 'amateur' }));
    expect(known[slotIndex('productionQuality', 'amateur')!]).toBeGreaterThan(0);

    expect(explainSimilarity(unknown, unknown, TAXONOMY_DIM).map((c) => c.dimension)).not.toContain(
      'productionQuality:unknown',
    );
  });
});

describe('normalize', () => {
  it('leaves an all-zero vector alone rather than dividing by zero', () => {
    const zeros = new Array<number>(TAXONOMY_DIM).fill(0);
    expect(normalize(zeros).every((v) => v === 0)).toBe(true);
  });
});

describe('explainSimilarity', () => {
  it('names the dimensions driving a match, largest first', () => {
    const vec = encodeFeatures(makeFeatures());
    const contributions = explainSimilarity(vec, vec, 3);
    expect(contributions.length).toBeGreaterThan(0);
    for (const c of contributions) {
      expect(TAXONOMY_LAYOUT).toContain(c.dimension as (typeof TAXONOMY_LAYOUT)[number]);
    }
    for (let i = 1; i < contributions.length; i++) {
      expect(contributions[i - 1]!.contribution).toBeGreaterThanOrEqual(
        contributions[i]!.contribution,
      );
    }
  });

  it('never attributes a match to an unknown value', () => {
    const vec = encodeFeatures(makeFeatures({ penisSize: 'unknown' }));
    expect(explainSimilarity(vec, vec, TAXONOMY_DIM).map((c) => c.dimension)).not.toContain(
      'penisSize:unknown',
    );
  });
});

describe('topDimensions', () => {
  it('reports the strongest tags in a profile vector', () => {
    const top = topDimensions(encodeFeatures(makeFeatures()), 5);
    expect(top.map((t) => t.dimension)).toContain('actType:posing');
  });
});

describe('toTagAffinity', () => {
  it('mirrors a vector into named tag weights for SQL candidate generation', () => {
    const affinity = toTagAffinity(encodeFeatures(makeFeatures()));
    expect(affinity['hairColor:blonde']).toBeGreaterThan(0);
    expect(affinity['hairColor:red']).toBeUndefined();
  });
});
