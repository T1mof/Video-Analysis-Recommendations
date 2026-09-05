import { z } from 'zod';
import { TAXONOMY, TAXONOMY_KEYS, type TaxonomyKey } from './taxonomy.ts';
import { videoFeaturesSchema, type VideoFeatures } from './schema.ts';

/**
 * Manually reviewed benchmark set and the metrics computed against it.
 *
 * Cost and latency are easy to measure and easy to over-value: a model that is
 * fast, cheap and wrong is worthless. This module supplies the missing axis -
 * tagging QUALITY against labels a human actually reviewed.
 *
 * Gold labels are used ONLY here, after inference. Nothing in the prompt, the
 * sampler, the provider or the mock reads this file; doing so would leak ground
 * truth into the system being measured.
 *
 * The set is small on purpose (~15 videos). It is not a statistically robust
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
  kind: 'single' | 'multi';
  /** Exact match for single-value fields, Jaccard overlap for multi-value ones. */
  score: number;
  /** Values the model produced that the reviewer did not - hallucinations. */
  spurious: string[];
  /** Values the reviewer recorded that the model did not - misses. */
  missed: string[];
  /** Multi-value only: |predicted ∩ gold| / |predicted|. */
  precision: number | null;
  /** Multi-value only: |predicted ∩ gold| / |gold|. */
  recall: number | null;
  goldIsUnknown: boolean;
  predictedIsUnknown: boolean;
  goldValue: string;
  predictedValue: string;
  /** Kept so aggregation can micro-average instead of averaging ratios. */
  intersectionSize: number;
  predictedSize: number;
  goldSize: number;
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

function render(value: string | readonly string[]): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/** Compares one model output against one reviewed label set. */
export function compareToGold(predicted: VideoFeatures, gold: GoldLabel): ComparisonResult {
  const perField: FieldAgreement[] = [];

  for (const field of TAXONOMY_KEYS) {
    const kind = TAXONOMY[field].kind;
    const predictedRaw = predicted[field];
    const goldRaw = gold.labels[field];

    const predictedValues = asSet(predictedRaw);
    const goldValues = asSet(goldRaw);

    const intersection = [...predictedValues].filter((v) => goldValues.has(v));
    const union = new Set([...predictedValues, ...goldValues]);

    // Two empty multi-value fields is agreement, not a divide-by-zero.
    const score =
      union.size === 0
        ? 1
        : kind === 'single'
          ? intersection.length > 0
            ? 1
            : 0
          : intersection.length / union.size;

    // Precision/recall are meaningless for a single-value field, where they would
    // both just restate exact match.
    const precision =
      kind === 'multi'
        ? predictedValues.size === 0
          ? goldValues.size === 0
            ? 1
            : 0
          : intersection.length / predictedValues.size
        : null;
    const recall =
      kind === 'multi'
        ? goldValues.size === 0
          ? predictedValues.size === 0
            ? 1
            : 1
          : intersection.length / goldValues.size
        : null;

    perField.push({
      field,
      kind,
      score,
      spurious: [...predictedValues].filter((v) => !goldValues.has(v)),
      missed: [...goldValues].filter((v) => !predictedValues.has(v)),
      precision,
      recall,
      goldIsUnknown: kind === 'single' && goldRaw === 'unknown',
      predictedIsUnknown: kind === 'single' && predictedRaw === 'unknown',
      goldValue: render(goldRaw),
      predictedValue: render(predictedRaw),
      intersectionSize: intersection.length,
      predictedSize: predictedValues.size,
      goldSize: goldValues.size,
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

export interface FieldReport {
  field: TaxonomyKey;
  kind: 'single' | 'multi';
  videos: number;
  /** Mean score over every video the model produced valid output for. */
  strictScore: number;
  /**
   * Mean score over every video the model was *asked* about, so a video it failed
   * to answer at all scores 0 here. Equals strictScore when nothing failed.
   */
  endToEndScore: number;
  /**
   * Mean score over videos where the reviewer committed to a value.
   *
   * Reported separately because the two answer different questions. Strict asks
   * "does the model agree with the reviewer, including when the reviewer said they
   * could not tell?" - and a model that also answers unknown scores 1 there, which
   * flatters it. Informative asks "when there IS a right answer, does the model
   * find it?" Averaging the two together would hide both.
   */
  informativeScore: number | null;
  informativeVideos: number;
  /** How often the reviewer could not tell. */
  goldUnknown: number;
  /**
   * How often the model answered unknown. Compared against goldUnknown this shows
   * over-caution (model >> reviewer) or guessing (model << reviewer).
   */
  predictedUnknown: number;
  /** Multi-value only, micro-averaged over all videos. */
  precision: number | null;
  recall: number | null;
  spurious: number;
  missed: number;
}

export interface BenchmarkSummary {
  /** Videos that produced valid, scoreable output. */
  videos: number;
  /** Videos the model was asked about. Larger than `videos` when some failed. */
  attempted: number;
  /** videos / attempted. */
  coverage: number;
  /** Mean of per-video macro scores, over scored videos only. */
  macroScore: number;
  /** Macro over single fields only. */
  singleMacro: number;
  /** Macro over multi fields only. */
  multiMacro: number;
  /**
   * Failure-penalised macro scores.
   *
   * A model that refuses half the corpus and is excellent on the rest is not a
   * usable analyser, but `macroScore` alone cannot say so - it only ever sees the
   * videos that succeeded. These divide by everything the model was asked about,
   * which is the same as scoring a failed video 0 on every field. Two models are
   * only comparable on `macroScore` when their coverage matches.
   */
  endToEndMacro: number;
  endToEndSingleMacro: number;
  endToEndMultiMacro: number;
  byField: Record<string, number>;
  fieldReports: FieldReport[];
  totalSpurious: number;
  totalMissed: number;
}

/**
 * @param attempted Videos the model was asked about. Defaults to the number of
 *   results, i.e. "nothing failed"; pass the full gold size when some videos
 *   produced no valid output so the failure-penalised scores are meaningful.
 */
export function summarize(
  results: readonly ComparisonResult[],
  attempted: number = results.length,
): BenchmarkSummary {
  const byField: Record<string, number> = {};
  const fieldReports: FieldReport[] = [];

  for (const field of TAXONOMY_KEYS) {
    const entries = results
      .map((r) => r.perField.find((f) => f.field === field))
      .filter((f): f is FieldAgreement => f !== undefined);

    const scoreTotal = entries.reduce((sum, f) => sum + f.score, 0);
    const strictScore = entries.length ? scoreTotal / entries.length : 0;
    const endToEndScore = attempted > 0 ? scoreTotal / attempted : 0;

    const informative = entries.filter((f) => !f.goldIsUnknown);
    const kind = TAXONOMY[field].kind;

    // Micro-average: sum intersections and denominators across videos rather than
    // averaging per-video ratios, so a video tagged with five values carries more
    // weight than one tagged with a single value.
    const intersectionTotal = entries.reduce((sum, f) => sum + f.intersectionSize, 0);
    const predictedTotal = entries.reduce((sum, f) => sum + f.predictedSize, 0);
    const goldTotal = entries.reduce((sum, f) => sum + f.goldSize, 0);

    fieldReports.push({
      field,
      kind,
      videos: entries.length,
      strictScore,
      endToEndScore,
      informativeScore: informative.length
        ? informative.reduce((sum, f) => sum + f.score, 0) / informative.length
        : null,
      informativeVideos: informative.length,
      goldUnknown: entries.filter((f) => f.goldIsUnknown).length,
      predictedUnknown: entries.filter((f) => f.predictedIsUnknown).length,
      precision:
        kind === 'multi' ? (predictedTotal === 0 ? 1 : intersectionTotal / predictedTotal) : null,
      recall: kind === 'multi' ? (goldTotal === 0 ? 1 : intersectionTotal / goldTotal) : null,
      spurious: entries.reduce((sum, f) => sum + f.spurious.length, 0),
      missed: entries.reduce((sum, f) => sum + f.missed.length, 0),
    });

    byField[field] = strictScore;
  }

  const singleReports = fieldReports.filter((f) => f.kind === 'single');
  const multiReports = fieldReports.filter((f) => f.kind === 'multi');

  const macroTotal = results.reduce((sum, r) => sum + r.macroScore, 0);
  const mean = (reports: FieldReport[], pick: (f: FieldReport) => number): number =>
    reports.length ? reports.reduce((sum, f) => sum + pick(f), 0) / reports.length : 0;

  return {
    videos: results.length,
    attempted,
    coverage: attempted > 0 ? results.length / attempted : 0,
    macroScore: results.length ? macroTotal / results.length : 0,
    singleMacro: mean(singleReports, (f) => f.strictScore),
    multiMacro: mean(multiReports, (f) => f.strictScore),
    endToEndMacro: attempted > 0 ? macroTotal / attempted : 0,
    endToEndSingleMacro: mean(singleReports, (f) => f.endToEndScore),
    endToEndMultiMacro: mean(multiReports, (f) => f.endToEndScore),
    byField,
    fieldReports,
    totalSpurious: results.reduce((sum, r) => sum + r.spuriousCount, 0),
    totalMissed: results.reduce((sum, r) => sum + r.missedCount, 0),
  };
}

export interface ErrorPattern {
  field: TaxonomyKey;
  goldValue: string;
  predictedValue: string;
  count: number;
  examples: string[];
}

/**
 * The most frequent (field, gold -> predicted) confusions.
 *
 * An aggregate score says a model is weak; this says *how*. "Every outdoor scene
 * read as a studio" and "random noise across settings" produce the same accuracy
 * and need completely different responses.
 */
export function topErrorPatterns(
  results: readonly ComparisonResult[],
  limit = 5,
): ErrorPattern[] {
  const counts = new Map<string, ErrorPattern>();

  for (const result of results) {
    for (const field of result.perField) {
      if (field.score === 1) continue;

      const key = `${field.field}|${field.goldValue}|${field.predictedValue}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 3) existing.examples.push(result.videoId);
      } else {
        counts.set(key, {
          field: field.field,
          goldValue: field.goldValue,
          predictedValue: field.predictedValue,
          count: 1,
          examples: [result.videoId],
        });
      }
    }
  }

  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
