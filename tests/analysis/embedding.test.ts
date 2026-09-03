import { describe, expect, it } from 'vitest';
import {
  cosine,
  encodeFeatures,
  explainSimilarity,
  normalize,
  topDimensions,
} from '../../src/analysis/embedding.ts';
import { TAXONOMY_DIM, slotIndex } from '../../src/analysis/taxonomy.ts';
import { makeFeatures } from '../fixtures.ts';

describe('encodeFeatures', () => {
  it('produces a unit vector of the declared dimension', () => {
    const vec = encodeFeatures(makeFeatures(), 30);
    expect(vec).toHaveLength(TAXONOMY_DIM);
    expect(cosine(vec, vec)).toBeCloseTo(1, 10);
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('is deterministic', () => {
    expect(encodeFeatures(makeFeatures(), 30)).toEqual(encodeFeatures(makeFeatures(), 30));
  });

  it('lights up the slot matching a tag and leaves others dark', () => {
    const vec = encodeFeatures(makeFeatures({ hairColor: ['blonde'] }), 30);
    const blonde = slotIndex('hairColor', 'blonde')!;
    const red = slotIndex('hairColor', 'red')!;
    expect(vec[blonde]).toBeGreaterThan(0);
    expect(vec[red]).toBe(0);
  });

  it('scores videos sharing tags above videos sharing none', () => {
    const blondeBedroom = encodeFeatures(makeFeatures(), 30);
    const blondeBedroom2 = encodeFeatures(
      makeFeatures({ mood: 'sensual', aestheticScore: 0.6 }),
      28,
    );
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
      30,
    );

    expect(cosine(blondeBedroom, blondeBedroom2)).toBeGreaterThan(
      cosine(blondeBedroom, different),
    );
  });

  it('weights a tag down when the model reports low confidence', () => {
    const confident = encodeFeatures(makeFeatures({ confidence: { hairColor: 1.0 } }), 30);
    const unsure = encodeFeatures(makeFeatures({ confidence: { hairColor: 0.1 } }), 30);
    const blonde = slotIndex('hairColor', 'blonde')!;
    expect(confident[blonde]!).toBeGreaterThan(unsure[blonde]!);
  });

  it('splits a field\'s weight across multiple selected values', () => {
    const one = encodeFeatures(makeFeatures({ actType: ['posing'] }), 30);
    const many = encodeFeatures(
      makeFeatures({ actType: ['posing', 'dancing', 'undressing'] }),
      30,
    );
    const posing = slotIndex('actType', 'posing')!;
    // A video tagged with three acts must not outweigh one tagged with a single act.
    expect(many[posing]!).toBeLessThan(one[posing]!);
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
    const vec = encodeFeatures(makeFeatures(), 30);
    const contributions = explainSimilarity(vec, vec, 3);
    expect(contributions.length).toBeGreaterThan(0);
    // Every reported dimension carries a human name, either "field=value" for a
    // taxonomy slot or a bare name for a continuous one.
    for (const c of contributions) {
      expect(c.dimension).toMatch(/^(\w+=\w+|aestheticScore|durationNorm)$/);
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
    const vec = encodeFeatures(makeFeatures(), 30);
    const top = topDimensions(vec, 5);
    expect(top.map((t) => t.dimension)).toContain('actType=posing');
  });
});
