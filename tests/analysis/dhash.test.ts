import { describe, expect, it } from 'vitest';
import {
  HASH_BYTES,
  HASH_HEIGHT,
  HASH_WIDTH,
  dHashFromGray,
  dedupeByHash,
  hammingDistance,
} from '../../src/analysis/dhash.ts';

/** Builds a 9x8 grayscale buffer from a per-pixel function. */
function gray(fn: (col: number, row: number) => number): Uint8Array {
  const buffer = new Uint8Array(HASH_BYTES);
  for (let row = 0; row < HASH_HEIGHT; row++) {
    for (let col = 0; col < HASH_WIDTH; col++) {
      buffer[row * HASH_WIDTH + col] = Math.max(0, Math.min(255, Math.round(fn(col, row))));
    }
  }
  return buffer;
}

describe('dHashFromGray', () => {
  it('produces 16 hex characters, i.e. 64 bits', () => {
    const hash = dHashFromGray(gray((col) => col * 20));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    const image = gray((col, row) => col * 13 + row * 7);
    expect(dHashFromGray(image)).toBe(dHashFromGray(image));
  });

  it('gives all-zero bits for a left-to-right ramp', () => {
    // Each pixel is darker than its right neighbour, so every comparison is 0.
    expect(dHashFromGray(gray((col) => col * 20))).toBe('0'.repeat(16));
  });

  it('gives all-one bits for a right-to-left ramp', () => {
    expect(dHashFromGray(gray((col) => 200 - col * 20))).toBe('f'.repeat(16));
  });

  it('is unchanged by uniform brightness shifts', () => {
    // dHash compares neighbours, so exposure changes must not alter the hash.
    const dim = gray((col) => 40 + col * 10);
    const bright = gray((col) => 90 + col * 10);
    expect(dHashFromGray(bright)).toBe(dHashFromGray(dim));
  });

  it('rejects a buffer of the wrong size', () => {
    expect(() => dHashFromGray(new Uint8Array(10))).toThrow(/expects 72/);
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('0123456789abcdef', '0123456789abcdef')).toBe(0);
  });

  it('is 64 for fully opposite hashes', () => {
    expect(hammingDistance('0'.repeat(16), 'f'.repeat(16))).toBe(64);
  });

  it('counts differing bits, not differing characters', () => {
    // 0x1 vs 0x0 differs in one bit; 0xf vs 0x0 differs in four.
    expect(hammingDistance('1000000000000000', '0000000000000000')).toBe(1);
    expect(hammingDistance('f000000000000000', '0000000000000000')).toBe(4);
  });

  it('is symmetric', () => {
    const a = '0f1e2d3c4b5a6978';
    const b = 'ffff000011112222';
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it('refuses to compare different lengths', () => {
    expect(() => hammingDistance('0000', '00000000')).toThrow(/different lengths/);
  });
});

describe('dedupeByHash', () => {
  const frame = (hash: string, timestampSec = 0) => ({ hash, timestampSec });

  it('keeps a single frame untouched', () => {
    const items = [frame('0000000000000000')];
    expect(dedupeByHash(items, 6, 1).kept).toEqual(items);
  });

  it('removes near-identical consecutive frames', () => {
    const items = [
      frame('0000000000000000', 1),
      frame('0000000000000001', 2), // 1 bit away
      frame('ffffffffffffffff', 3),
    ];
    const { kept, removed } = dedupeByHash(items, 6, 1);
    expect(kept.map((f) => f.timestampSec)).toEqual([1, 3]);
    expect(removed.map((f) => f.timestampSec)).toEqual([2]);
  });

  it('keeps everything when all frames are distinct', () => {
    const items = [
      frame('0000000000000000', 1),
      frame('ffffffffffffffff', 2),
      frame('0f0f0f0f0f0f0f0f', 3),
    ];
    expect(dedupeByHash(items, 6, 1).kept).toHaveLength(3);
  });

  it('compares against the last kept frame, so a slow pan is not collapsed', () => {
    // Each step is 2 bits from the previous, but the last is 8 bits from the first.
    const items = [
      frame('0000000000000000', 1),
      frame('0000000000000003', 2),
      frame('000000000000000f', 3),
      frame('00000000000000ff', 4),
    ];
    const { kept } = dedupeByHash(items, 3, 1);
    // Drift accumulates against the anchor, so the end of the pan survives.
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.at(-1)!.timestampSec).toBe(4);
  });

  it('respects the minimum, restoring the most distinctive discards', () => {
    const items = [
      frame('0000000000000000', 1),
      frame('0000000000000001', 2), // 1 bit
      frame('0000000000000003', 3), // 2 bits
      frame('0000000000000007', 4), // 3 bits - most distinctive discard
    ];
    const { kept } = dedupeByHash(items, 60, 3);
    expect(kept).toHaveLength(3);
    expect(kept.map((f) => f.timestampSec)).toContain(4);
  });

  it('returns kept frames in chronological order even after restoration', () => {
    const items = [
      frame('0000000000000000', 1),
      frame('0000000000000001', 2),
      frame('0000000000000003', 3),
      frame('0000000000000007', 4),
    ];
    const { kept } = dedupeByHash(items, 60, 3);
    const times = kept.map((f) => f.timestampSec);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('cannot restore more frames than exist', () => {
    const items = [frame('0000000000000000', 1), frame('0000000000000001', 2)];
    expect(dedupeByHash(items, 60, 5).kept).toHaveLength(2);
  });

  it('handles an empty input', () => {
    expect(dedupeByHash([], 6, 3)).toEqual({ kept: [], removed: [] });
  });

  it('collapses a genuinely static video to very few frames', () => {
    const identical = Array.from({ length: 8 }, (_, i) => frame('0000000000000000', i));
    const { kept } = dedupeByHash(identical, 6, 3);
    // Paying a model for eight copies of one image buys nothing.
    expect(kept.length).toBe(3);
  });
});
