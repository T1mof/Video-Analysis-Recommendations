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
      makeFeatures({ hairColor: 'platinum_blonde' as never }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a v1 value that taxonomy v2 removed', () => {
    expect(
      videoFeaturesSchema.safeParse(makeFeatures({ hairColor: 'brunette' as never })).success,
    ).toBe(false);
    expect(
      videoFeaturesSchema.safeParse(makeFeatures({ explicitness: 'hardcore' as never })).success,
    ).toBe(false);
  });

  it('rejects an array where taxonomy v2 expects a single value', () => {
    const result = videoFeaturesSchema.safeParse(
      makeFeatures({ clothing: ['lingerie'] as never }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const input = makeFeatures();
    delete (input as Partial<typeof input>).sexPosition;
    expect(videoFeaturesSchema.safeParse(input).success).toBe(false);
  });

  it('accepts "unknown" wherever the taxonomy offers it', () => {
    const result = videoFeaturesSchema.safeParse(
      makeFeatures({ hairColor: 'unknown', bodyType: 'unknown', adultAgeGroup: 'unknown' }),
    );
    expect(result.success).toBe(true);
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

  it('mirrors taxonomy cardinality: string for single, array for multi', () => {
    const json = jsonSchemaForFeatures() as {
      properties: Record<string, { type: string; enum?: string[]; items?: { enum: string[] } }>;
    };
    expect(json.properties.clothing?.type).toBe('string');
    expect(json.properties.clothing?.enum).toContain('partially_nude');
    expect(json.properties.actType?.type).toBe('array');
    expect(json.properties.actType?.items?.enum).toContain('penetrative_sex');
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
    expect(prompt).toContain('blonde, dark, red, colored, other, unknown');
  });

  it('separates single-value from multi-value instructions', () => {
    const prompt = buildPrompt(8, 32.5);
    expect(prompt).toContain('SINGLE-VALUE fields');
    expect(prompt).toContain('MULTI-VALUE fields');
    expect(prompt).toContain('[] is valid');
  });

  it('tells the model to use unknown rather than guess', () => {
    const prompt = buildPrompt(8, 32.5);
    expect(prompt).toContain('Do not guess');
    expect(prompt).toContain('dominant performer');
  });
});
