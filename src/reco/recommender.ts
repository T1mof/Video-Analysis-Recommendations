import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { events } from '../db/schema.ts';
import {
  type CandidateSource,
  type EligibleVideo,
  explorationBucket,
  generateCandidates,
} from './candidates.ts';
import { type DiversifiedCandidate, diversifyCandidates } from './diversity.ts';
import { FATIGUE_RECENT_VIDEOS, type UserRankingContext, rankCandidates } from './ranking.ts';
import { getUserProfile, rebuildUserProfile, type UserProfile } from './profile.ts';

/**
 * Orchestration only.
 *
 *   generate → union/dedupe/filter → score → diversify → ordered list
 *
 * Each stage is a separate module and independently testable; this file just wires
 * them together and reports what happened. There is deliberately no feed here, and
 * no Redis: turning an ordered candidate list into a served feed is M7, and the
 * whole point of the 3k RPS design is that the request path never reaches this code.
 */

export interface RecommendationDiagnostics {
  coldStart: boolean;
  requestedLimit: number;
  returned: number;
  candidateCounts: Record<CandidateSource, number>;
  uniqueCandidates: number;
  eligibleVideos: number;
  filteredSeen: number;
  /** Fewer unseen eligible videos exist than were requested. */
  candidateShortage: boolean;
  diversityRelaxed: boolean;
  relaxedCount: number;
  latencyMs: number;
}

export interface RecommendationResult {
  userId: string;
  items: DiversifiedCandidate[];
  /** Video metadata for the returned items, so callers need no second query. */
  videos: Map<string, EligibleVideo>;
  diagnostics: RecommendationDiagnostics;
}

export interface RecommendOptions {
  now?: Date;
  /** Rebuild the profile first. Off by default: reading is the hot-path shape. */
  rebuildProfile?: boolean;
}

/**
 * The user's most recent distinct videos, newest first - the fatigue window.
 *
 * Distinct videos, not events: three events on one video are one exposure. Reading
 * a bounded slice keeps this cheap regardless of history length.
 */
async function loadRecentVideos(
  userId: string,
  eligible: Map<string, EligibleVideo>,
): Promise<EligibleVideo[]> {
  const rows = await db
    .select({ videoId: events.videoId, createdAt: events.createdAt })
    .from(events)
    .where(eq(events.userId, userId))
    .orderBy(desc(events.createdAt))
    .limit(FATIGUE_RECENT_VIDEOS * 5);

  const recent: EligibleVideo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.videoId)) continue;
    seen.add(row.videoId);
    const video = eligible.get(row.videoId);
    // A video with no features still counts as an exposure for seen-filtering, but
    // it has no tags to be fatigued by, so it cannot contribute here.
    if (video) recent.push(video);
    if (recent.length >= FATIGUE_RECENT_VIDEOS) break;
  }
  return recent;
}

export async function recommendCandidates(
  userId: string,
  limit: number,
  options: RecommendOptions = {},
): Promise<RecommendationResult> {
  const started = Date.now();
  const now = options.now ?? new Date();

  const profile = options.rebuildProfile
    ? await rebuildUserProfile(userId, { now })
    : ((await getUserProfile(userId)) ?? (await rebuildUserProfile(userId, { now })));

  const generation = await generateCandidates(profile, limit, { now });
  const recentVideos = await loadRecentVideos(userId, generation.eligible);

  const context: UserRankingContext = {
    userId,
    profileVector: profile.vector,
    isColdStart: profile.isColdStart,
    creatorAffinity: new Map(profile.creatorAffinity.map((c) => [c.creatorId, c.score])),
    recentVideos,
    now,
    explorationBucket: explorationBucket(now),
  };

  const ranked = rankCandidates(
    generation.candidates,
    generation.eligible,
    context,
    generation.engagement,
  );
  const diversified = diversifyCandidates(ranked, generation.eligible, limit);

  return {
    userId,
    items: diversified.selected,
    videos: generation.eligible,
    diagnostics: {
      coldStart: profile.isColdStart,
      requestedLimit: limit,
      returned: diversified.selected.length,
      candidateCounts: generation.countsBySource,
      uniqueCandidates: generation.candidates.length,
      eligibleVideos: generation.eligibleCount,
      filteredSeen: generation.seenCount,
      candidateShortage: generation.exhausted,
      diversityRelaxed: diversified.diversityRelaxed,
      relaxedCount: diversified.relaxedCount,
      latencyMs: Date.now() - started,
    },
  };
}

export type { UserProfile };
