import { cosine } from '../analysis/embedding.ts';
import { TAXONOMY, type TaxonomyKey, isUninformative, slotIndex } from '../analysis/taxonomy.ts';
import { env } from '../config/env.ts';
import type { Candidate, CandidateSource, EligibleVideo } from './candidates.ts';
import { explorationScore } from './candidates.ts';
import { diversityTags } from './diversityTags.ts';

/**
 * Ranking: a transparent weighted sum, not a learned model.
 *
 *   score = W_AFFINITY         * affinity
 *         + W_QUALITY          * quality
 *         + W_FRESHNESS        * freshness
 *         + W_POPULARITY       * popularity
 *         - W_FATIGUE          * fatigue
 *         + W_EXPLORATION      * exploration
 *         + W_CREATOR_AFFINITY * creatorAffinity
 *
 * **The weights are heuristic priors, not trained coefficients**, because no
 * production interaction dataset exists yet. They encode an opinion about what
 * should matter, and they are honest about being an opinion. Replacing them with a
 * learned ranker is planned separately as M8.7, and this stage's interface is what
 * makes that a drop-in change.
 *
 * Numeric signals live here rather than inside the taxonomy vector: the vector
 * answers "is this the same kind of content?", ranking answers "is this item good,
 * and right for this user now?". Keeping them apart means weights can be retuned
 * without re-encoding a single vector.
 */

/**
 * Freshness half-life. A module constant rather than a new environment variable:
 * the config already carries 78 keys and this is not something an operator tunes
 * per deployment. A week means yesterday's video still competes, last month's
 * barely does.
 */
export const FRESHNESS_HALFLIFE_HOURS = 168;

/**
 * How many recent distinct videos count as "what the user has been seeing lately"
 * for fatigue.
 */
export const FATIGUE_RECENT_VIDEOS = 20;

export interface RankingFeatures {
  /** cosine(profile, video), [-1, 1]. Negative means it matches active dislikes. */
  contentSimilarity: number;
  /** Mean signed preference over the video's meaningful tags, [-1, 1]. */
  tagAffinity: number;
  /** Mean of the two above, [-1, 1]. */
  affinity: number;
  /** From user_creator_affinity, signed. 0 when the video has no creator. */
  creatorAffinity: number;
  /** Normalised engagement in the trending window, [0, 1]. */
  popularity: number;
  /** Exponential decay on age, [0, 1]. */
  freshness: number;
  /** Repetitiveness against recent history, [0, 1]. Subtracted. */
  fatigue: number;
  /** Deterministic per user/video/day, [0, 1]. */
  exploration: number;
  /** Model-reported aesthetic score, [0, 1]. Zero when unavailable. */
  quality: number;
  qualityAvailable: boolean;
}

export interface ScoredCandidate {
  videoId: string;
  sources: CandidateSource[];
  features: RankingFeatures;
  /** Each feature multiplied by its weight - what actually moved the score. */
  weighted: Record<string, number>;
  baseScore: number;
}

export interface UserRankingContext {
  userId: string;
  profileVector: number[];
  isColdStart: boolean;
  creatorAffinity: Map<string, number>;
  /** Recent distinct videos, newest first - the fatigue window. */
  recentVideos: EligibleVideo[];
  now: Date;
  explorationBucket: string;
}

/**
 * Interpretable per-tag match: the mean of the user's signed preference across the
 * meaningful taxonomy values this video actually carries.
 *
 * Distinct from cosine similarity, which is a geometric summary of all 110
 * dimensions at once. This one can be read aloud: "you like `setting:pool` at 0.31
 * and dislike `actType:talking` at -0.12, so this video scores 0.09".
 */
export function tagAffinity(profileVector: readonly number[], video: EligibleVideo): number {
  const values: number[] = [];

  for (const field of Object.keys(TAXONOMY) as TaxonomyKey[]) {
    const raw = video.features[field];
    const candidates = Array.isArray(raw) ? raw : [raw];
    for (const value of new Set(candidates)) {
      if (typeof value !== 'string') continue;
      // `unknown` carries no information and `none` means the feature is absent -
      // neither is a preference the user can hold.
      if (isUninformative(value) || value === 'none') continue;
      const index = slotIndex(field, value);
      if (index === undefined) continue;
      values.push(profileVector[index] ?? 0);
    }
  }

  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Exponential decay on age. Bounded [0,1] and never NaN for a future timestamp. */
export function freshness(createdAt: Date, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
  return Math.pow(0.5, ageHours / FRESHNESS_HALFLIFE_HOURS);
}

/**
 * Signed engagement scaled into [0,1] against the strongest positive engagement in
 * the window.
 *
 * **Scope is the whole trending window, not the caller's candidate set.**
 * `loadEngagement` aggregates every event in the window across the entire corpus
 * with no user or candidate filter, so a given video scores the same for every
 * user, at every requested limit, whatever else landed in their pool. Normalising
 * inside a per-user candidate set would make popularity context-dependent - the
 * same video "more popular" for one user than another - which is not what the word
 * means and would make the feature impossible to reason about.
 *
 * Negative engagement clamps to 0 rather than being min-max rescaled. Min-max over
 * signed values has a nasty failure: in a window where everything is net-negative,
 * the *least* skipped video maps to 1.0 and is promoted as the most popular thing
 * in the catalogue. Skips and dislikes should push popularity toward zero, which is
 * exactly what they now do.
 *
 * Edge cases, all NaN-free: nothing engaged (empty map), a single engaged video
 * (1.0 if positive, 0 if not), every value identical and positive (all 1.0 - a
 * constant offset that cannot change the ordering), every value ≤ 0 (all 0). A
 * video with no events at all is simply absent and reads as 0 at lookup.
 */
export function normalisePopularity(engagement: Map<string, number>): Map<string, number> {
  const normalised = new Map<string, number>();

  let maxPositive = 0;
  for (const value of engagement.values()) {
    if (Number.isFinite(value) && value > maxPositive) maxPositive = value;
  }

  for (const [videoId, value] of engagement) {
    const positive = Number.isFinite(value) ? Math.max(0, value) : 0;
    normalised.set(videoId, maxPositive === 0 ? 0 : positive / maxPositive);
  }
  return normalised;
}

/**
 * Fatigue: how repetitive this video is against what the user has recently seen.
 *
 * Distinct from diversity, and the distinction matters. Fatigue looks *backwards*
 * at history; diversity looks *sideways* within the list being built. A feed can be
 * internally diverse and still be the fifth day in a row of the same creator.
 *
 * Measured over recent distinct *videos*, not events: a view, a complete and a like
 * of one video are one exposure, not three.
 */
export function fatigue(video: EligibleVideo, recent: readonly EligibleVideo[]): number {
  if (recent.length === 0) return 0;

  let creatorFrequency = 0;
  if (video.creatorId) {
    const sameCreator = recent.filter((r) => r.creatorId === video.creatorId).length;
    creatorFrequency = sameCreator / recent.length;
  }

  const tags = diversityTags(video.features);
  let tagFrequency = 0;
  for (const tag of tags) {
    const sameTag = recent.filter((r) => diversityTags(r.features).includes(tag)).length;
    tagFrequency = Math.max(tagFrequency, sameTag / recent.length);
  }

  // Scaled by how full the window is. A frequency measured over three videos is
  // noise, and at full strength it would outweigh every positive term - a user who
  // has seen three videos would be told they are tired of all of them. Confidence
  // reaches 1 only once there is a real history to measure.
  const confidence = Math.min(1, recent.length / FATIGUE_RECENT_VIDEOS);
  return Math.max(creatorFrequency, tagFrequency) * confidence;
}

const WEIGHTS = () => ({
  affinity: env.RANK_W_AFFINITY,
  quality: env.RANK_W_QUALITY,
  freshness: env.RANK_W_FRESHNESS,
  popularity: env.RANK_W_POPULARITY,
  fatigue: env.RANK_W_FATIGUE,
  exploration: env.RANK_W_EXPLORATION,
  creatorAffinity: env.RANK_W_CREATOR_AFFINITY,
});

/**
 * `aestheticScore` is the model's own 0..1 judgement of visual appeal.
 *
 * `productionQuality` is deliberately NOT used here: professional vs amateur is a
 * kind of content and plausibly a user preference, not a measure of how good a
 * recommendation is. Treating it as quality would silently push every user toward
 * studio content.
 *
 * The caveat on aestheticScore is that it is a model self-report and was never
 * validated against the gold set, so it is a weak prior - which is why its weight
 * is the smallest of the seven.
 */
function quality(video: EligibleVideo): { value: number; available: boolean } {
  const score = video.features.aestheticScore;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { value: 0, available: false };
  }
  return { value: Math.max(0, Math.min(1, score)), available: true };
}

export function scoreCandidate(
  candidate: Candidate,
  video: EligibleVideo,
  context: UserRankingContext,
  popularity: Map<string, number>,
): ScoredCandidate {
  const weights = WEIGHTS();

  // A cold-start profile is built on too little evidence to steer the feed. Rather
  // than pretending a sparse vector is a taste, personalised terms are zeroed and
  // the global signals decide the order.
  const contentSimilarity = context.isColdStart
    ? 0
    : clampFinite(cosine(context.profileVector, video.vector));
  const tagScore = context.isColdStart ? 0 : clampFinite(tagAffinity(context.profileVector, video));
  const affinity = context.isColdStart ? 0 : (contentSimilarity + tagScore) / 2;

  const creatorAffinity =
    context.isColdStart || !video.creatorId
      ? 0
      : clampFinite(context.creatorAffinity.get(video.creatorId) ?? 0);

  const qualitySignal = quality(video);

  const features: RankingFeatures = {
    contentSimilarity,
    tagAffinity: tagScore,
    affinity,
    creatorAffinity,
    popularity: popularity.get(video.videoId) ?? 0,
    freshness: freshness(video.createdAt, context.now),
    fatigue: fatigue(video, context.recentVideos),
    exploration: explorationScore(context.userId, video.videoId, context.explorationBucket),
    quality: qualitySignal.value,
    qualityAvailable: qualitySignal.available,
  };

  const weighted = {
    affinity: weights.affinity * features.affinity,
    quality: weights.quality * features.quality,
    freshness: weights.freshness * features.freshness,
    popularity: weights.popularity * features.popularity,
    fatigue: -weights.fatigue * features.fatigue,
    exploration: weights.exploration * features.exploration,
    creatorAffinity: weights.creatorAffinity * features.creatorAffinity,
  };

  const baseScore = Object.values(weighted).reduce((sum, v) => sum + v, 0);

  return {
    videoId: candidate.videoId,
    sources: [...candidate.sources],
    features,
    weighted,
    baseScore,
  };
}

export function rankCandidates(
  candidates: readonly Candidate[],
  eligible: Map<string, EligibleVideo>,
  context: UserRankingContext,
  engagement: Map<string, number>,
): ScoredCandidate[] {
  const popularity = normalisePopularity(engagement);

  const scored = candidates
    .map((candidate) => {
      const video = eligible.get(candidate.videoId);
      return video ? scoreCandidate(candidate, video, context, popularity) : null;
    })
    .filter((s): s is ScoredCandidate => s !== null);

  return sortDeterministically(scored, (s) => s.baseScore);
}

/**
 * Ties broken by video id so that the same inputs always produce the same order.
 * Without this, two videos with identical scores could swap places between calls
 * and make the output impossible to test or explain.
 */
export function sortDeterministically<T extends { videoId: string }>(
  items: T[],
  score: (item: T) => number,
): T[] {
  return [...items].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
  });
}

/** Any non-finite value here is a bug upstream; it must never reach a score. */
function clampFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
