import { describe, expect, it } from 'vitest';
import {
  TAXONOMY,
  TAXONOMY_DIM,
  TAXONOMY_KEYS,
  TAXONOMY_LAYOUT,
  TAXONOMY_VERSION,
  describeSlot,
  isUninformative,
  slotIndex,
} from '../../src/analysis/taxonomy.ts';

/**
 * The layout is a storage format: index N in TAXONOMY_LAYOUT is dimension N of
 * every embedding ever written at this taxonomy version. These tests exist to make
 * an accidental reorder fail loudly instead of silently invalidating stored vectors.
 */
describe('TAXONOMY_LAYOUT', () => {
  it('covers every taxonomy value exactly once', () => {
    const expected: string[] = [];
    for (const key of TAXONOMY_KEYS) {
      for (const value of TAXONOMY[key].values) expected.push(`${key}:${value}`);
    }
    expect([...TAXONOMY_LAYOUT].sort()).toEqual(expected.sort());
    expect(new Set(TAXONOMY_LAYOUT).size).toBe(TAXONOMY_LAYOUT.length);
  });

  it('pins the dimension count', () => {
    // Changing this number invalidates every stored embedding and the pgvector
    // column type. If this test fails, bump TAXONOMY_VERSION and re-encode.
    expect(TAXONOMY_DIM).toBe(110);
  });

  it('pins the taxonomy version', () => {
    expect(TAXONOMY_VERSION).toBe(2);
  });

  it('pins the first and last slots against accidental reordering', () => {
    expect(TAXONOMY_LAYOUT[0]).toBe('performerCount:none');
    expect(TAXONOMY_LAYOUT[TAXONOMY_DIM - 1]).toBe('fetishTags:public');
  });

  it('contains only categorical slots - no continuous features', () => {
    for (const tag of TAXONOMY_LAYOUT) {
      const [key, value] = tag.split(':');
      expect(TAXONOMY_KEYS).toContain(key as (typeof TAXONOMY_KEYS)[number]);
      expect(TAXONOMY[key as (typeof TAXONOMY_KEYS)[number]].values).toContain(value as never);
    }
  });

  it('round-trips a tag through slotIndex and describeSlot', () => {
    const index = slotIndex('explicitness', 'explicit')!;
    expect(describeSlot(index)).toBe('explicitness:explicit');
  });

  it('returns undefined for a value outside the taxonomy', () => {
    expect(slotIndex('hairColor', 'platinum_blonde')).toBeUndefined();
    expect(slotIndex('hairColor', 'brunette')).toBeUndefined();
  });
});

describe('taxonomy v2 structure', () => {
  it('declares 19 fields: 16 single, 3 multi', () => {
    const single = TAXONOMY_KEYS.filter((k) => TAXONOMY[k].kind === 'single');
    const multi = TAXONOMY_KEYS.filter((k) => TAXONOMY[k].kind === 'multi');
    expect(TAXONOMY_KEYS).toHaveLength(19);
    expect(single).toHaveLength(16);
    expect(multi).toEqual(['appearanceFeatures', 'actType', 'fetishTags']);
  });

  it('has dropped the v1 fields', () => {
    for (const removed of ['mood', 'performerGenders', 'cameraFraming']) {
      expect(TAXONOMY_KEYS).not.toContain(removed as (typeof TAXONOMY_KEYS)[number]);
    }
  });

  it('has no "none" sentinel in multi-value fields - absence is []', () => {
    for (const key of TAXONOMY_KEYS) {
      if (TAXONOMY[key].kind !== 'multi') continue;
      expect(TAXONOMY[key].values).not.toContain('none' as never);
    }
  });

  it('keeps tattoos and piercings in appearanceFeatures, not fetishTags', () => {
    expect(TAXONOMY.appearanceFeatures.values).toEqual(['tattoos', 'piercings']);
    expect(TAXONOMY.fetishTags.values).not.toContain('tattoos' as never);
    expect(TAXONOMY.fetishTags.values).not.toContain('piercings' as never);
  });

  it('keeps the specific penetration type out of actType', () => {
    expect(TAXONOMY.actType.values).toContain('penetrative_sex');
    expect(TAXONOMY.actType.values).not.toContain('vaginal' as never);
    expect(TAXONOMY.actType.values).not.toContain('anal' as never);
  });
});

describe('isUninformative', () => {
  it('treats only "unknown" as missing information', () => {
    expect(isUninformative('unknown')).toBe(true);
    // "none" and "other" are real observations, not absent ones.
    expect(isUninformative('none')).toBe(false);
    expect(isUninformative('other')).toBe(false);
  });

  it('offers "unknown" on every single-value field where it is meaningful', () => {
    // productionQuality was the last holdout; a model that cannot judge production
    // value must have a way to say so rather than being forced to guess "amateur".
    expect(TAXONOMY.productionQuality.values).toEqual([
      'amateur',
      'semi_pro',
      'professional',
      'unknown',
    ]);
  });
});
