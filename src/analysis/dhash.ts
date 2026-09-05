import { env } from '../config/env.ts';

/**
 * Difference hash (dHash) for near-duplicate frame removal.
 *
 * Chosen over any learned embedding or CV library because the job is narrow: tell
 * whether two frames of the same video show essentially the same thing. dHash does
 * that from a 9x8 grayscale thumbnail and 64 bit comparisons - no model, no native
 * dependency, no GPU, and it is stable enough that the result is reproducible.
 *
 * The pixels come from ffmpeg (see frames.ts), which already has to be installed;
 * this module only does arithmetic.
 */

export const HASH_WIDTH = 9;
export const HASH_HEIGHT = 8;
export const HASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT; // 64
export const HASH_BYTES = HASH_WIDTH * HASH_HEIGHT; // 72 grayscale samples

/**
 * Builds a 64-bit hash from a 9x8 grayscale buffer, comparing each pixel with its
 * right-hand neighbour. Encoded as 16 lowercase hex characters.
 */
export function dHashFromGray(gray: Uint8Array): string {
  if (gray.length !== HASH_BYTES) {
    throw new Error(
      `dHash expects ${HASH_BYTES} grayscale samples (${HASH_WIDTH}x${HASH_HEIGHT}), got ${gray.length}`,
    );
  }

  const bits: number[] = [];
  for (let row = 0; row < HASH_HEIGHT; row++) {
    for (let col = 0; col < HASH_WIDTH - 1; col++) {
      const left = gray[row * HASH_WIDTH + col]!;
      const right = gray[row * HASH_WIDTH + col + 1]!;
      bits.push(left > right ? 1 : 0);
    }
  }

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!;
    hex += nibble.toString(16);
  }
  return hex;
}

/** Number of differing bits. 0 = identical, 64 = maximally different. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare hashes of different lengths: ${a.length} vs ${b.length}`);
  }

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

export interface HashedItem {
  hash: string;
}

export interface DedupeResult<T> {
  kept: T[];
  removed: T[];
}

/**
 * Removes frames that look essentially the same as the one before them.
 *
 * Comparison is against the last KEPT frame rather than the immediately preceding
 * one, so a slow pan does not survive as a chain of pairwise-similar frames that
 * are collectively very different from where it started.
 *
 * Items must arrive in temporal order: adjacency in time is what makes "the
 * previous frame" the right thing to compare against.
 *
 * `minKeep` guards against over-pruning. A video that genuinely holds one static
 * shot throughout will still yield fewer frames than requested, which is correct -
 * paying a VLM for eight copies of the same image buys nothing - but a floor keeps
 * enough context for the model to judge motion and progression.
 */
export function dedupeByHash<T extends HashedItem>(
  items: readonly T[],
  threshold: number = env.DEDUP_HAMMING_THRESHOLD,
  minKeep: number = env.MIN_ANALYSIS_FRAMES,
): DedupeResult<T> {
  if (items.length === 0) return { kept: [], removed: [] };

  const kept: T[] = [items[0]!];
  const removed: { item: T; distance: number }[] = [];

  for (let i = 1; i < items.length; i++) {
    const candidate = items[i]!;
    const reference = kept[kept.length - 1]!;
    const distance = hammingDistance(reference.hash, candidate.hash);

    if (distance <= threshold) {
      removed.push({ item: candidate, distance });
    } else {
      kept.push(candidate);
    }
  }

  // Restore the most distinctive discards until the floor is met. Anything put back
  // was below the threshold, but "least similar of the similar" is the best
  // available coverage.
  if (kept.length < minKeep && removed.length > 0) {
    removed.sort((a, b) => b.distance - a.distance);
    while (kept.length < minKeep && removed.length > 0) {
      kept.push(removed.shift()!.item);
    }
  }

  const keptSet = new Set(kept);
  return {
    // Restoration can break temporal order; callers rely on it being chronological.
    kept: items.filter((item) => keptSet.has(item)),
    removed: items.filter((item) => !keptSet.has(item)),
  };
}
