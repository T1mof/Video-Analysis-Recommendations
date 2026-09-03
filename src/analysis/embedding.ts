import {
  CATEGORICAL_DIM,
  TAXONOMY,
  TAXONOMY_DIM,
  TAXONOMY_KEYS,
  describeSlot,
  slotIndex,
} from './taxonomy.ts';
import { confidenceFor, type VideoFeatures } from './schema.ts';

/**
 * Deterministic taxonomy embedding.
 *
 * A confidence-weighted multi-hot encoding of the closed taxonomy - no second
 * model, no GPU, no drift between runs. The payoff is that user profiles are
 * built in the *same* space (a profile is just a weighted sum of video vectors),
 * so cosine similarity decomposes back into named tag contributions and the demo
 * can answer "why was this recommended?" with real dimension names.
 *
 * The cost is that anything outside the taxonomy is invisible. The upgrade path
 * (concatenate a text embedding of the caption, or move to a learned two-tower
 * encoder) is discussed in ARCHITECTURE.md.
 */

/** Duration at which the normalised-duration dimension saturates. */
const DURATION_SATURATION_S = 180;

export function encodeFeatures(features: VideoFeatures, durationSeconds: number): number[] {
  const vec = new Array<number>(TAXONOMY_DIM).fill(0);

  for (const key of TAXONOMY_KEYS) {
    const field = TAXONOMY[key];
    const confidence = confidenceFor(features, key);
    const raw = features[key];
    const values: string[] = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) continue;

    // Spread a field's weight across its selected values so a video tagged with
    // five acts does not dominate one tagged with a single act.
    const share = field.weight / Math.sqrt(values.length);

    for (const value of values) {
      const idx = slotIndex(key, value);
      if (idx === undefined) continue; // unreachable after Zod validation
      vec[idx] = share * confidence;
    }
  }

  vec[CATEGORICAL_DIM] = features.aestheticScore;
  vec[CATEGORICAL_DIM + 1] = Math.min(durationSeconds / DURATION_SATURATION_S, 1);

  return normalize(vec);
}

export function normalize(vec: number[]): number[] {
  let sumSquares = 0;
  for (const v of vec) sumSquares += v * v;
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function addScaled(target: number[], source: readonly number[], scale: number): number[] {
  for (let i = 0; i < target.length; i++) {
    target[i] = (target[i] ?? 0) + (source[i] ?? 0) * scale;
  }
  return target;
}

export function zeroVector(): number[] {
  return new Array<number>(TAXONOMY_DIM).fill(0);
}

export interface Contribution {
  dimension: string;
  contribution: number;
}

/**
 * Breaks a dot product into its largest named terms. This is what the demo panel
 * renders under each video, and what makes the ranker auditable.
 */
export function explainSimilarity(
  profile: readonly number[],
  video: readonly number[],
  topN = 5,
): Contribution[] {
  const terms: Contribution[] = [];
  for (let i = 0; i < TAXONOMY_DIM; i++) {
    const product = (profile[i] ?? 0) * (video[i] ?? 0);
    if (product > 0) {
      terms.push({ dimension: describeSlot(i), contribution: product });
    }
  }
  terms.sort((a, b) => b.contribution - a.contribution);
  return terms.slice(0, topN);
}

/** Top tag names in a profile vector - shown as "your taste" in the demo. */
export function topDimensions(vec: readonly number[], topN = 8): Contribution[] {
  const terms: Contribution[] = [];
  for (let i = 0; i < CATEGORICAL_DIM; i++) {
    const value = vec[i] ?? 0;
    if (value > 0) terms.push({ dimension: describeSlot(i), contribution: value });
  }
  terms.sort((a, b) => b.contribution - a.contribution);
  return terms.slice(0, topN);
}
