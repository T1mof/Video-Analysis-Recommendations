import { z } from 'zod';
import { TAXONOMY, TAXONOMY_KEYS, type TaxonomyKey } from './taxonomy.ts';
import { videoFeaturesSchema, type VideoFeatures } from './schema.ts';

/**
 * Manually reviewed benchmark set.
 *
 * Cost and latency are easy to measure and easy to over-value: a model that is
 * fast, cheap and wrong is worthless. This module supplies the missing axis -
 * tagging QUALITY against labels a human actually reviewed - so scripts/bench-vlm.ts
 * compares candidate models on accuracy, missed tags and hallucinated tags, which
 * is what PROJECT_CONTEXT.md asks the benchmark to decide on.
 *
 * The set is small on purpose (~10-15 videos). It is not a statistically robust
 * evaluation and is not presented as one; it is a smoke test sharp enough to catch
 * a model that systematically misreads the taxonomy.
 */

const goldLabelSchema = z.object({
  videoId: z.string().min(1),
  /** Free-text note from the reviewer: ambiguity, judgement calls, edge cases. */
  note: z.string().optional(),
  /** Reviewer's labels. Same shape as model output minus the generated extras. */
  labels: videoFeaturesSchema.omit({ aestheticScore: true, caption: true, confidence: true }),
});

export const goldDatasetSchema = z.object({
  taxonomyVersion: z.number().int(),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().min(1),
  items: z.array(goldLabelSchema).min(1),
});

export type GoldLabel = z.infer<typeof goldLabelSchema>;
export type GoldDataset = z.infer<typeof goldDatasetSchema>;

export interface FieldAgreement {
  field: TaxonomyKey;
  /** Exact match for single-value fields, Jaccard overlap for multi-value ones. */
  score: number;
  /** Values the model produced that the reviewer did not - hallucinations. */
  spurious: string[];
  /** Values the reviewer recorded that the model did not - misses. */
  missed: string[];
}

export interface ComparisonResult {
  videoId: string;
  perField: FieldAgreement[];
  /** Unweighted mean across fields; every field counts the same. */
  macroScore: number;
  spuriousCount: number;
  missedCount: number;
}

function asSet(value: string | readonly string[]): Set<string> {
  return new Set(Array.isArray(value) ? value : [value as string]);
}

/** Compares one model output against one reviewed label set. */
export function compareToGold(predicted: VideoFeatures, gold: GoldLabel): ComparisonResult {
  const perField: FieldAgreement[] = [];

  for (const field of TAXONOMY_KEYS) {
    const predictedValues = asSet(predicted[field]);
    const goldValues = asSet(gold.labels[field]);

    const intersection = [...predictedValues].filter((v) => goldValues.has(v));
    const union = new Set([...predictedValues, ...goldValues]);

    // Two empty multi-value fields is agreement, not a divide-by-zero.
    const score =
      union.size === 0
        ? 1
        : TAXONOMY[field].kind === 'single'
          ? intersection.length > 0
            ? 1
            : 0
          : intersection.length / union.size;

    perField.push({
      field,
      score,
      spurious: [...predictedValues].filter((v) => !goldValues.has(v)),
      missed: [...goldValues].filter((v) => !predictedValues.has(v)),
    });
  }

  const macroScore = perField.reduce((sum, f) => sum + f.score, 0) / perField.length;

  return {
    videoId: gold.videoId,
    perField,
    macroScore,
    spuriousCount: perField.reduce((sum, f) => sum + f.spurious.length, 0),
    missedCount: perField.reduce((sum, f) => sum + f.missed.length, 0),
  };
}

export interface BenchmarkSummary {
  videos: number;
  /** Mean of per-video macro scores. */
  macroScore: number;
  /** Per-field mean across all videos - shows WHICH fields a model is weak on. */
  byField: Record<string, number>;
  totalSpurious: number;
  totalMissed: number;
}

export function summarize(results: readonly ComparisonResult[]): BenchmarkSummary {
  const byField: Record<string, number> = {};
  for (const field of TAXONOMY_KEYS) {
    const scores = results.map(
      (r) => r.perField.find((f) => f.field === field)?.score ?? 0,
    );
    byField[field] = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
  }

  return {
    videos: results.length,
    macroScore: results.length
      ? results.reduce((sum, r) => sum + r.macroScore, 0) / results.length
      : 0,
    byField,
    totalSpurious: results.reduce((sum, r) => sum + r.spuriousCount, 0),
    totalMissed: results.reduce((sum, r) => sum + r.missedCount, 0),
  };
}
