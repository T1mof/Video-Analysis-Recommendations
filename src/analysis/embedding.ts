import {
  TAXONOMY,
  TAXONOMY_DIM,
  TAXONOMY_KEYS,
  describeSlot,
  slotIndex,
} from './taxonomy.ts';
import { confidenceFor, type VideoFeatures } from './schema.ts';

/**
 * Deterministic taxonomy embedding - CATEGORICAL DIMENSIONS ONLY.
 *
 * A confidence-weighted multi-hot encoding of the closed taxonomy: no second
 * model, no GPU, no drift between runs. Because a user profile is built in the
 * same space (a weighted sum of video vectors), cosine similarity decomposes back
 * into named tag contributions, so the demo can answer "why was this
 * recommended?" with real dimension names.
 *
 * What is NOT in here, on purpose: aestheticScore, duration, popularity,
 * freshness. Those are continuous quality/context signals, not content identity.
 * Folding them into the vector would corrupt the meaning of cosine similarity -
 * two unrelated videos would look "similar" merely for being equally popular or
 * equally long. They are applied as separate weighted terms at the ranking stage
 * (../recommend/rank.ts), where they can be tuned independently and where their
 * effect stays auditable.
 *
 * The cost of a categorical-only vector is that anything outside the taxonomy is
 * invisible. The upgrade path (concatenate a text embedding of the caption, or
 * move to a learned two-tower encoder) is discussed in ARCHITECTURE.md.
 */

export function encodeFeatures(features: VideoFeatures): number[] {
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
  for (let i = 0; i < TAXONOMY_DIM; i++) {
    const value = vec[i] ?? 0;
    if (value > 0) terms.push({ dimension: describeSlot(i), contribution: value });
  }
  terms.sort((a, b) => b.contribution - a.contribution);
  return terms.slice(0, topN);
}

/**
 * Tag affinity map mirrored from a profile vector, for tag-based candidate
 * generation (a SQL query over the jsonb features) and for display. Keys are
 * "field:value" strings matching TAXONOMY_LAYOUT.
 */
export function toTagAffinity(vec: readonly number[], minWeight = 0.01): Record<string, number> {
  const affinity: Record<string, number> = {};
  for (let i = 0; i < TAXONOMY_DIM; i++) {
    const value = vec[i] ?? 0;
    if (value > minWeight) affinity[describeSlot(i)] = value;
  }
  return affinity;
}
