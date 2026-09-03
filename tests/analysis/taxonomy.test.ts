import { describe, expect, it } from 'vitest';
import {
  TAXONOMY,
  TAXONOMY_DIM,
  TAXONOMY_KEYS,
  TAXONOMY_LAYOUT,
  describeSlot,
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
    expect(TAXONOMY_DIM).toBe(83);
  });

  it('pins the first and last slots against accidental reordering', () => {
    expect(TAXONOMY_LAYOUT[0]).toBe('performerCount:none');
    expect(TAXONOMY_LAYOUT[TAXONOMY_DIM - 1]).toBe('mood:neutral');
  });

  it('contains only categorical slots - no continuous features', () => {
    for (const tag of TAXONOMY_LAYOUT) {
      const [key, value] = tag.split(':');
      expect(TAXONOMY_KEYS).toContain(key as (typeof TAXONOMY_KEYS)[number]);
      expect(TAXONOMY[key as (typeof TAXONOMY_KEYS)[number]].values).toContain(value as never);
    }
  });

  it('round-trips a tag through slotIndex and describeSlot', () => {
    const index = slotIndex('explicitness', 'hardcore')!;
    expect(describeSlot(index)).toBe('explicitness:hardcore');
  });

  it('returns undefined for a value outside the taxonomy', () => {
    expect(slotIndex('hairColor', 'platinum_blonde')).toBeUndefined();
  });
});
