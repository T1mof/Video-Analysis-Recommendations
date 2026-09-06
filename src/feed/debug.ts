import type { CandidateSource } from '../reco/candidates.ts';
import type { RecommendationResult } from '../reco/recommender.ts';
import { diversityTags } from '../reco/diversityTags.ts';
import { env } from '../config/env.ts';
import type { FeedGeneration } from './cache.ts';

/**
 * The explanation sidecar: why each item of one generation is where it is.
 *
 * It exists because the demo has to answer "why this video?" without the answer
 * costing a second ranking run. The M6 result already contains every number - all
 * nine features, all seven weighted terms, the diversity penalty - and then throws
 * them away, because a *feed* payload should be small and a cache exists to be read
 * fast. So the sidecar captures that diagnostic output at build time, once, in the
 * worker, and the demo reads it as data.
 *
 * The two rules that make this safe:
 *
 *   1. **It is derived, never recomputed.** `projectFeedDebug` is a pure mapping over
 *      a result the worker already has. There is no code path from reading a sidecar
 *      back to the recommender, pgvector or Postgres.
 *   2. **It is bound to one generation.** Same feedId, same lifetime, evicted by the
 *      same retention rule. An explanation that outlived the ranking it explains
 *      would be worse than no explanation.
 *
 * `GET /feed` never reads it. It is a demonstration surface, not production API - see
 * `src/api/demo.ts`.
 *
 * What it deliberately does **not** contain: the user's profile vector, video
 * embeddings, raw VLM output or captions. Those are large, and none of them is needed
 * to explain a ranking decision.
 */

/** All floats are rounded before storage: this is a display artefact, not a metric. */
function r4(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0;
}

export interface FeedDebugItem {
  videoId: string;
  rank: number;
  /** Every candidate source that produced this video. */
  sources: CandidateSource[];
  creatorHandle: string | null;
  externalId: string | null;
  /**
   * The same meaningful taxonomy values diversity and fatigue reason about, from the
   * one centralised policy in `diversityTags.ts`. Reusing it means the tags shown to
   * a reviewer are literally the tags the reranker acted on, rather than a second,
   * subtly different notion of "the interesting tags".
   */
  tags: string[];
  features: {
    contentSimilarity: number;
    tagAffinity: number;
    affinity: number;
    creatorAffinity: number;
    popularity: number;
    freshness: number;
    fatigue: number;
    exploration: number;
    quality: number;
    qualityAvailable: boolean;
  };
  /** Each feature already multiplied by its weight - what actually moved the score. */
  weighted: Record<string, number>;
  baseScore: number;
  diversityPenalty: number;
  finalScore: number;
  admittedByRelaxation: boolean;
}

export interface FeedDebugGeneration {
  feedId: string;
  userId: string;
  epoch: number;
  generatedAt: string;
  coldStart: boolean;
  /** The weights in force when this generation was built, so the sum is checkable. */
  weights: Record<string, number>;
  candidateCounts: Record<CandidateSource, number>;
  uniqueCandidates: number;
  eligibleVideos: number;
  filteredSeen: number;
  candidateShortage: boolean;
  diversityRelaxed: boolean;
  relaxedCount: number;
  buildLatencyMs: number;
  items: FeedDebugItem[];
}

/**
 * Projects an M6 result onto the sidecar, for the generation just built from it.
 *
 * Pure and synchronous on purpose: it must be obvious by inspection that explaining a
 * feed costs no query. The generation is passed in rather than re-derived so the two
 * can never disagree about feedId, epoch or ordering.
 */
export function projectFeedDebug(
  generation: FeedGeneration,
  result: RecommendationResult,
): FeedDebugGeneration {
  const items: FeedDebugItem[] = result.items.map((item, index) => {
    const video = result.videos.get(item.videoId);
    return {
      videoId: item.videoId,
      rank: index + 1,
      sources: [...item.sources],
      creatorHandle: video?.creatorHandle ?? null,
      externalId: video?.externalId ?? null,
      tags: video ? diversityTags(video.features) : [],
      features: {
        contentSimilarity: r4(item.features.contentSimilarity),
        tagAffinity: r4(item.features.tagAffinity),
        affinity: r4(item.features.affinity),
        creatorAffinity: r4(item.features.creatorAffinity),
        popularity: r4(item.features.popularity),
        freshness: r4(item.features.freshness),
        fatigue: r4(item.features.fatigue),
        exploration: r4(item.features.exploration),
        quality: r4(item.features.quality),
        qualityAvailable: item.features.qualityAvailable,
      },
      weighted: Object.fromEntries(
        Object.entries(item.weighted).map(([key, value]) => [key, r4(value)]),
      ),
      baseScore: r4(item.baseScore),
      diversityPenalty: r4(item.diversityPenalty),
      finalScore: r4(item.finalScore),
      admittedByRelaxation: item.admittedByRelaxation,
    };
  });

  return {
    feedId: generation.feedId,
    userId: generation.userId,
    epoch: generation.epoch,
    generatedAt: generation.generatedAt,
    coldStart: generation.coldStart,
    weights: {
      affinity: env.RANK_W_AFFINITY,
      quality: env.RANK_W_QUALITY,
      freshness: env.RANK_W_FRESHNESS,
      popularity: env.RANK_W_POPULARITY,
      fatigue: -env.RANK_W_FATIGUE,
      exploration: env.RANK_W_EXPLORATION,
      creatorAffinity: env.RANK_W_CREATOR_AFFINITY,
    },
    candidateCounts: result.diagnostics.candidateCounts,
    uniqueCandidates: result.diagnostics.uniqueCandidates,
    eligibleVideos: result.diagnostics.eligibleVideos,
    filteredSeen: result.diagnostics.filteredSeen,
    candidateShortage: result.diagnostics.candidateShortage,
    diversityRelaxed: result.diagnostics.diversityRelaxed,
    relaxedCount: result.diagnostics.relaxedCount,
    buildLatencyMs: result.diagnostics.latencyMs,
    items,
  };
}
