import { describe, expect, it } from 'vitest';
import { videoFeaturesSchema, jsonSchemaForFeatures, buildPrompt } from '../../src/analysis/schema.ts';
import { TAXONOMY_KEYS } from '../../src/analysis/taxonomy.ts';
import { makeFeatures } from '../fixtures.ts';

describe('videoFeaturesSchema', () => {
  it('accepts a well-formed feature set', () => {
    const result = videoFeaturesSchema.safeParse(makeFeatures());
    expect(result.success).toBe(true);
  });

  it('rejects a hallucinated tag outside the taxonomy', () => {
    const result = videoFeaturesSchema.safeParse(
      makeFeatures({ hairColor: ['platinum_blonde'] as never }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range aesthetic score', () => {
    const result = videoFeaturesSchema.safeParse(makeFeatures({ aestheticScore: 1.4 }));
    expect(result.success).toBe(false);
  });

  it('accepts empty multi-value fields', () => {
    const result = videoFeaturesSchema.safeParse(makeFeatures({ fetishTags: [] }));
    expect(result.success).toBe(true);
  });

  it('defaults confidence to an empty object', () => {
    const input = makeFeatures();
    delete (input as Partial<typeof input>).confidence;
    const result = videoFeaturesSchema.parse(input);
    expect(result.confidence).toEqual({});
  });
});

describe('jsonSchemaForFeatures', () => {
  it('requires every taxonomy field plus the extras', () => {
    const json = jsonSchemaForFeatures() as { required: string[]; properties: object };
    for (const key of TAXONOMY_KEYS) {
      expect(json.required).toContain(key);
    }
    expect(json.required).toEqual(
      expect.arrayContaining(['aestheticScore', 'caption', 'confidence']),
    );
  });
});

describe('buildPrompt', () => {
  it('states the frame count and duration being described', () => {
    const prompt = buildPrompt(8, 32.5);
    expect(prompt).toContain('8 frames');
    expect(prompt).toContain('32.5 seconds');
  });

  it('enumerates the allowed values so the model cannot invent a vocabulary', () => {
    const prompt = buildPrompt(8, 32.5);
    for (const key of TAXONOMY_KEYS) {
      expect(prompt).toContain(key);
    }
    expect(prompt).toContain('blonde, brunette, black, red, colored, other');
  });
});
