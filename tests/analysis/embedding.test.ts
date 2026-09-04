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
    const vec = encodeFeatures(makeFeatures({ hairColor: ['blonde'] }));
    expect(vec[slotIndex('hairColor', 'blonde')!]).toBeGreaterThan(0);
    expect(vec[slotIndex('hairColor', 'red')!]).toBe(0);
  });

  it('scores videos sharing tags above videos sharing none', () => {
    const a = encodeFeatures(makeFeatures());
    const similar = encodeFeatures(makeFeatures({ mood: 'sensual' }));
    const different = encodeFeatures(
      makeFeatures({
        hairColor: ['black'],
        setting: 'outdoor',
        clothing: ['swimwear'],
        actType: ['dancing'],
        fetishTags: ['public'],
        performerCount: 'duo',
        mood: 'intense',
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

  it('carries content only - ranking-stage signals do not enter the vector', () => {
    // Two videos with identical tags but wildly different aesthetic scores are
    // content-identical. Quality/freshness/popularity are scored in rank.ts, so
    // their weights can change without re-encoding vectors or rebuilding HNSW.
    const dull = encodeFeatures(makeFeatures({ aestheticScore: 0.05 }));
    const stunning = encodeFeatures(makeFeatures({ aestheticScore: 0.99 }));
    expect(dull).toEqual(stunning);
    expect(cosine(dull, stunning)).toBeCloseTo(1, 10);
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
