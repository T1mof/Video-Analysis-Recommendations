import { cosine } from '../analysis/embedding.ts';
import { env } from '../config/env.ts';
import type { EligibleVideo } from './candidates.ts';
import { diversityTags } from './diversityTags.ts';
import { sortDeterministically, type ScoredCandidate } from './ranking.ts';

/**
 * Diversity re-ranking - a separate pass over the ranked list, never folded into
 * the scoring formula.
 *
 * Without it the ranker converges on a narrow slice of the catalogue: every item
 * scores well individually and the feed is monotonous. Two independent rules,
 * because they fail differently - ten creators shooting near-identical content, or
 * one creator across genuinely varied content. Only one rule catches each case.
 */

export interface DiversifiedCandidate extends ScoredCandidate {
  /** λ × similarity to the most similar already-selected item. Always ≥ 0. */
  diversityPenalty: number;
  finalScore: number;
  /** True when this item was admitted only after the caps were relaxed. */
  admittedByRelaxation: boolean;
}

export interface DiversityResult {
  selected: DiversifiedCandidate[];
  /** True when hard caps had to be relaxed to reach the requested limit. */
  diversityRelaxed: boolean;
  relaxedCount: number;
}

export interface DiversityOptions {
  lambda?: number;
  maxSameCreator?: number;
  maxSameTagInTop10?: number;
}

const TOP_WINDOW = 10;

interface SelectionState {
  selectedVideos: EligibleVideo[];
  creatorCounts: Map<string, number>;
  tagCounts: Map<string, number>;
}

/**
 * Penalty for repeating what is already in the list.
 *
 * `rerankScore = baseScore − λ × max(0, maxCosineToSelected)`
 *
 * Only positive similarity is penalised: a candidate that is the *opposite* of what
 * is already selected is the diverse choice, and rewarding it with a bonus would
 * turn diversity into a second, hidden ranking signal.
 */
function similarityPenalty(
  candidate: EligibleVideo,
  selected: readonly EligibleVideo[],
  lambda: number,
): number {
  if (selected.length === 0) return 0;

  let maxSimilarity = 0;
  for (const chosen of selected) {
    const similarity = cosine(candidate.vector, chosen.vector);
    if (Number.isFinite(similarity) && similarity > maxSimilarity) maxSimilarity = similarity;
  }
  return lambda * maxSimilarity;
}

/**
 * Cap check.
 *
 * A null creator is exempt rather than pooled: treating "creator unknown" as one
 * shared creator would let three anonymous videos block each other, which is the
 * opposite of what the rule is for. The tag cap applies only within the top window,
 * where monotony is actually visible.
 */
function violatesCaps(
  video: EligibleVideo,
  state: SelectionState,
  position: number,
  maxSameCreator: number,
  maxSameTagInTop10: number,
): boolean {
  if (video.creatorId) {
    const used = state.creatorCounts.get(video.creatorId) ?? 0;
    if (used >= maxSameCreator) return true;
  }

  if (position < TOP_WINDOW) {
    for (const tag of diversityTags(video.features)) {
      const used = state.tagCounts.get(tag) ?? 0;
      if (used >= maxSameTagInTop10) return true;
    }
  }

  return false;
}

function admit(video: EligibleVideo, state: SelectionState, position: number): void {
  state.selectedVideos.push(video);
  if (video.creatorId) {
    state.creatorCounts.set(video.creatorId, (state.creatorCounts.get(video.creatorId) ?? 0) + 1);
  }
  if (position < TOP_WINDOW) {
    for (const tag of diversityTags(video.features)) {
      state.tagCounts.set(tag, (state.tagCounts.get(tag) ?? 0) + 1);
    }
  }
}

/**
 * Greedy selection with a two-pass fallback.
 *
 * Pass 1 honours every constraint. Pass 2 runs only if the list is still short and
 * candidates remain, and fills the rest by score with the caps lifted. On a
 * 30-video corpus the caps can genuinely make a full list impossible, and returning
 * four videos when ten exist would be a worse answer than a slightly repetitive
 * ten - so the relaxation is recorded in diagnostics rather than hidden.
 */
export function diversifyCandidates(
  ranked: readonly ScoredCandidate[],
  eligible: Map<string, EligibleVideo>,
  limit: number,
  options: DiversityOptions = {},
): DiversityResult {
  const lambda = options.lambda ?? env.DIVERSITY_LAMBDA;
  const maxSameCreator = options.maxSameCreator ?? env.DIVERSITY_MAX_SAME_CREATOR;
  const maxSameTagInTop10 = options.maxSameTagInTop10 ?? env.DIVERSITY_MAX_SAME_TAG_IN_TOP10;

  const state: SelectionState = {
    selectedVideos: [],
    creatorCounts: new Map(),
    tagCounts: new Map(),
  };

  const remaining = new Map(ranked.map((candidate) => [candidate.videoId, candidate]));
  const selected: DiversifiedCandidate[] = [];

  // Pass 1: constraints enforced.
  while (selected.length < limit && remaining.size > 0) {
    let best: { candidate: ScoredCandidate; video: EligibleVideo; score: number } | null = null;

    for (const candidate of remaining.values()) {
      const video = eligible.get(candidate.videoId);
      if (!video) continue;
      if (violatesCaps(video, state, selected.length, maxSameCreator, maxSameTagInTop10)) continue;

      const score = candidate.baseScore - similarityPenalty(video, state.selectedVideos, lambda);
      if (
        !best ||
        score > best.score ||
        (score === best.score && candidate.videoId < best.candidate.videoId)
      ) {
        best = { candidate, video, score };
      }
    }

    if (!best) break; // Constraints block everything that is left.

    const penalty = similarityPenalty(best.video, state.selectedVideos, lambda);
    admit(best.video, state, selected.length);
    remaining.delete(best.candidate.videoId);
    selected.push({
      ...best.candidate,
      diversityPenalty: penalty,
      finalScore: best.candidate.baseScore - penalty,
      admittedByRelaxation: false,
    });
  }

  // Pass 2: caps lifted, order still by score, so the tail is the best of what the
  // constraints excluded rather than an arbitrary remainder.
  let relaxedCount = 0;
  if (selected.length < limit && remaining.size > 0) {
    const leftovers = sortDeterministically([...remaining.values()], (c) => c.baseScore);
    for (const candidate of leftovers) {
      if (selected.length >= limit) break;
      const video = eligible.get(candidate.videoId);
      if (!video) continue;

      const penalty = similarityPenalty(video, state.selectedVideos, lambda);
      admit(video, state, selected.length);
      selected.push({
        ...candidate,
        diversityPenalty: penalty,
        finalScore: candidate.baseScore - penalty,
        admittedByRelaxation: true,
      });
      relaxedCount++;
    }
  }

  return {
    selected,
    diversityRelaxed: relaxedCount > 0,
    relaxedCount,
  };
}
