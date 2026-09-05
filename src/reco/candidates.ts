import { and, desc, eq, gte, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { cosineDistance, events, videoEmbeddings, videoFeatures, videos } from '../db/schema.ts';
import {
  TAXONOMY,
  TAXONOMY_DIM,
  TAXONOMY_VERSION,
  type TaxonomyKey,
  slotIndex,
} from '../analysis/taxonomy.ts';
import type { VideoFeatures } from '../analysis/schema.ts';
import { env } from '../config/env.ts';
import { type SignalEvent, eventWeight } from './signals.ts';
import type { UserProfile } from './profile.ts';

/**
 * Candidate generation: five independent sources, then union, dedupe and filter.
 *
 * No source filters, scores or orders - each returns a plain set of video ids under
 * its own cap. Filtering and ranking are common stages that run once over the merged
 * set, so an exclusion rule is written once instead of being repeated in five
 * queries, and one failing source can never starve the feed.
 */

export type CandidateSource = 'similar' | 'tag' | 'trending' | 'fresh' | 'explore';

export const CANDIDATE_SOURCES: readonly CandidateSource[] = [
  'similar',
  'tag',
  'trending',
  'fresh',
  'explore',
];

export interface Candidate {
  videoId: string;
  /** Every source that produced this video. A candidate appears exactly once. */
  sources: Set<CandidateSource>;
}

export interface EligibleVideo {
  videoId: string;
  creatorId: string | null;
  creatorHandle: string | null;
  externalId: string | null;
  createdAt: Date;
  vector: number[];
  features: VideoFeatures;
}

export interface CandidateGeneration {
  candidates: Candidate[];
  /** Videos eligible for recommendation, keyed by id - reused by ranking. */
  eligible: Map<string, EligibleVideo>;
  /** Raw popularity mass per video over the trending window, before normalisation. */
  engagement: Map<string, number>;
  countsBySource: Record<CandidateSource, number>;
  /** Distinct videos this user has already interacted with. */
  seenCount: number;
  eligibleCount: number;
  /** True when fewer unseen eligible videos exist than were asked for. */
  exhausted: boolean;
}

export interface GenerateOptions {
  now?: Date;
  /** Overrides the per-source caps; used by tests. */
  limits?: Partial<Record<CandidateSource, number>>;
}

const DEFAULT_LIMITS = (): Record<CandidateSource, number> => ({
  similar: env.CAND_SIMILAR_K,
  tag: env.CAND_TAG_K,
  trending: env.CAND_TRENDING_K,
  fresh: env.CAND_FRESH_K,
  explore: env.CAND_EXPLORE_K,
});

/**
 * Everything that may be recommended: analysed, with a taxonomy vector of the
 * current dimension. A video whose analysis failed or is pending has no features
 * and therefore cannot be ranked - one rule covers ingested, analyzing and failed,
 * which is why no separate `unavailable` status exists.
 *
 * Mock features are never substituted for missing ones: that would recommend a
 * video on invented content.
 */
export async function loadEligibleVideos(): Promise<Map<string, EligibleVideo>> {
  const rows = await db
    .select({
      videoId: videos.id,
      creatorId: videos.creatorId,
      creatorHandle: videos.creatorHandle,
      externalId: videos.externalId,
      createdAt: videos.createdAt,
      vector: videoEmbeddings.embedding,
      features: videoFeatures.features,
      taxonomyVersion: videoEmbeddings.taxonomyVersion,
    })
    .from(videos)
    .innerJoin(videoEmbeddings, eq(videoEmbeddings.videoId, videos.id))
    .innerJoin(videoFeatures, eq(videoFeatures.videoId, videos.id))
    .where(eq(videos.status, 'analyzed'));

  const eligible = new Map<string, EligibleVideo>();
  for (const row of rows) {
    // A vector of the wrong length is corrupt, not merely stale: ranking it would
    // silently compare different spaces.
    if (row.taxonomyVersion !== TAXONOMY_VERSION) continue;
    if (!Array.isArray(row.vector) || row.vector.length !== TAXONOMY_DIM) continue;
    if (row.vector.some((v) => !Number.isFinite(v))) continue;

    eligible.set(row.videoId, {
      videoId: row.videoId,
      creatorId: row.creatorId,
      creatorHandle: row.creatorHandle,
      externalId: row.externalId,
      createdAt: row.createdAt,
      vector: row.vector,
      features: row.features,
    });
  }
  return eligible;
}

/**
 * Videos the user has already interacted with, as distinct ids. An impression, a
 * view and a like of the same video are one seen item, not three.
 */
export async function loadSeen(userId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ videoId: events.videoId })
    .from(events)
    .where(eq(events.userId, userId));
  return new Set(rows.map((r) => r.videoId));
}

/** Signed, time-decayed engagement per video over the trending window. */
export async function loadEngagement(now: Date): Promise<Map<string, number>> {
  const windowStart = new Date(now.getTime() - env.TRENDING_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({ videoId: events.videoId, type: events.type, createdAt: events.createdAt })
    .from(events)
    .where(gte(events.createdAt, windowStart));

  const windowMs = env.TRENDING_WINDOW_HOURS * 3_600_000;
  const engagement = new Map<string, number>();

  for (const row of rows) {
    // Weights come from the M5 module rather than being restated in SQL: one source
    // of truth for what a like is worth.
    const weight = eventWeight(row.type as SignalEvent);
    if (weight === 0) continue;

    // Linear position in the window: an event at the edge is worth nothing, a fresh
    // one full value. Deliberately simpler than the profile's exponential decay -
    // this is a bounded window, not an unbounded history.
    const age = now.getTime() - row.createdAt.getTime();
    const recency = Math.max(0, Math.min(1, 1 - age / windowMs));
    engagement.set(row.videoId, (engagement.get(row.videoId) ?? 0) + weight * recency);
  }

  return engagement;
}

/**
 * Source A - content similarity. pgvector cosine over the user's profile vector.
 *
 * Exact scan is correct at this corpus size and the HNSW index takes over
 * transparently as the corpus grows: the query and its semantics do not change,
 * which is the point of expressing it in pgvector rather than in JavaScript.
 * Skipped for cold-start users, whose profile is not yet worth trusting.
 */
async function sourceSimilar(
  profile: UserProfile,
  exclude: Set<string>,
  limit: number,
): Promise<string[]> {
  if (profile.isColdStart) return [];
  if (profile.vector.every((v) => v === 0)) return [];

  const rows = await db
    .select({ videoId: videoEmbeddings.videoId })
    .from(videoEmbeddings)
    .innerJoin(videos, eq(videos.id, videoEmbeddings.videoId))
    .where(
      and(
        eq(videos.status, 'analyzed'),
        eq(videoEmbeddings.taxonomyVersion, TAXONOMY_VERSION),
        exclude.size > 0 ? notInArray(videoEmbeddings.videoId, [...exclude]) : undefined,
      ),
    )
    .orderBy(cosineDistance(videoEmbeddings.embedding, profile.vector))
    .limit(limit);

  return rows.map((r) => r.videoId);
}

/**
 * The frozen layout as field/value pairs, built once from `slotIndex` so a
 * dimension is never addressed by a hardcoded offset.
 */
const SLOT_TAGS: ({ field: TaxonomyKey; value: string } | undefined)[] = (() => {
  const cache: ({ field: TaxonomyKey; value: string } | undefined)[] = new Array(TAXONOMY_DIM);
  for (const field of Object.keys(TAXONOMY) as TaxonomyKey[]) {
    for (const value of TAXONOMY[field].values) {
      const index = slotIndex(field, value);
      if (index !== undefined) cache[index] = { field, value };
    }
  }
  return cache;
})();

/** The user's strongest positive taxonomy preferences, as field/value pairs. */
export function topPreferredTags(
  profile: UserProfile,
  topN = 8,
): { field: TaxonomyKey; value: string; weight: number }[] {
  const preferences: { field: TaxonomyKey; value: string; weight: number }[] = [];

  for (const [index, weight] of profile.vector.entries()) {
    if (weight <= 0) continue;
    const tag = SLOT_TAGS[index];
    if (!tag) continue;
    // `none`/`unknown` are not preferences: one means the feature is absent, the
    // other that nobody could tell. Neither is something to retrieve on.
    if (tag.value === 'none' || tag.value === 'unknown') continue;
    preferences.push({ ...tag, weight });
  }

  preferences.sort((a, b) => b.weight - a.weight);
  return preferences.slice(0, topN);
}

/**
 * Source B - explicit tag affinity.
 *
 * Not a second cosine query. It looks up videos that literally carry the user's
 * strongest preferred taxonomy values, using the GIN index on the features jsonb.
 * It generalises worse than the vector but is exact and explainable, and it keeps
 * working if the vector index is unavailable.
 */
async function sourceTag(
  profile: UserProfile,
  exclude: Set<string>,
  limit: number,
): Promise<string[]> {
  if (profile.isColdStart) return [];

  const preferred = topPreferredTags(profile, 8);
  if (preferred.length === 0) return [];

  const conditions = preferred.map(({ field, value }) =>
    TAXONOMY[field].kind === 'multi'
      ? sql`${videoFeatures.features} -> ${field} ? ${value}`
      : sql`${videoFeatures.features} ->> ${field} = ${value}`,
  );

  const rows = await db
    .select({ videoId: videoFeatures.videoId })
    .from(videoFeatures)
    .innerJoin(videos, eq(videos.id, videoFeatures.videoId))
    .where(
      and(
        eq(videos.status, 'analyzed'),
        sql`(${sql.join(conditions, sql` OR `)})`,
        exclude.size > 0 ? notInArray(videoFeatures.videoId, [...exclude]) : undefined,
      ),
    )
    .limit(limit);

  return rows.map((r) => r.videoId);
}

/** Source C - trending. Highest signed engagement in the window. */
function sourceTrending(
  engagement: Map<string, number>,
  eligible: Map<string, EligibleVideo>,
  exclude: Set<string>,
  limit: number,
): string[] {
  return [...engagement.entries()]
    .filter(([videoId, score]) => score > 0 && eligible.has(videoId) && !exclude.has(videoId))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([videoId]) => videoId);
}

/** Source D - fresh. Newest first. */
async function sourceFresh(exclude: Set<string>, limit: number): Promise<string[]> {
  const rows = await db
    .select({ videoId: videos.id })
    .from(videos)
    .innerJoin(videoEmbeddings, eq(videoEmbeddings.videoId, videos.id))
    .where(
      and(
        eq(videos.status, 'analyzed'),
        exclude.size > 0 ? notInArray(videos.id, [...exclude]) : undefined,
      ),
    )
    .orderBy(desc(videos.createdAt))
    .limit(limit);

  return rows.map((r) => r.videoId);
}

/**
 * Source E - exploration.
 *
 * Deterministic rather than random: the same user, video and time bucket always
 * produce the same score, so a feed is reproducible, a test can assert on it, and
 * "why did this appear?" has an answer. `Math.random()` in core ranking would make
 * all three impossible.
 */
export function explorationScore(userId: string, videoId: string, bucket: string): number {
  return hashUnit(`${userId}|${videoId}|${bucket}`);
}

/** UTC day - exploration rotates daily rather than per request. */
export function explorationBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hashUnit(input: string): number {
  // FNV-1a, then scaled into [0,1).
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

function sourceExplore(
  userId: string,
  eligible: Map<string, EligibleVideo>,
  exclude: Set<string>,
  limit: number,
  bucket: string,
): string[] {
  return [...eligible.keys()]
    .filter((videoId) => !exclude.has(videoId))
    .map((videoId) => ({ videoId, score: explorationScore(userId, videoId, bucket) }))
    .sort((a, b) => b.score - a.score || (a.videoId < b.videoId ? -1 : 1))
    .slice(0, limit)
    .map((entry) => entry.videoId);
}

/** Merges the sources, keeping every source that produced each video. */
export function unionCandidates(
  perSource: Partial<Record<CandidateSource, readonly string[]>>,
  eligible: Map<string, EligibleVideo>,
): Candidate[] {
  const merged = new Map<string, Candidate>();

  for (const source of CANDIDATE_SOURCES) {
    for (const videoId of perSource[source] ?? []) {
      // Post-union safety net: a source could return something ineligible if the
      // corpus changed between queries.
      if (!eligible.has(videoId)) continue;
      const existing = merged.get(videoId);
      if (existing) existing.sources.add(source);
      else merged.set(videoId, { videoId, sources: new Set([source]) });
    }
  }

  return [...merged.values()];
}

export async function generateCandidates(
  profile: UserProfile,
  requestedLimit: number,
  options: GenerateOptions = {},
): Promise<CandidateGeneration> {
  const now = options.now ?? new Date();
  const limits = { ...DEFAULT_LIMITS(), ...options.limits };

  const [eligible, seen, engagement] = await Promise.all([
    loadEligibleVideos(),
    loadSeen(profile.userId),
    loadEngagement(now),
  ]);

  const [similar, tag, fresh] = await Promise.all([
    sourceSimilar(profile, seen, limits.similar),
    sourceTag(profile, seen, limits.tag),
    sourceFresh(seen, limits.fresh),
  ]);
  const trending = sourceTrending(engagement, eligible, seen, limits.trending);
  const explore = sourceExplore(
    profile.userId,
    eligible,
    seen,
    limits.explore,
    explorationBucket(now),
  );

  const perSource = { similar, tag, trending, fresh, explore };
  const candidates = unionCandidates(perSource, eligible);

  const unseenEligible = [...eligible.keys()].filter((id) => !seen.has(id)).length;

  return {
    candidates,
    eligible,
    engagement,
    countsBySource: {
      similar: similar.length,
      tag: tag.length,
      trending: trending.length,
      fresh: fresh.length,
      explore: explore.length,
    },
    seenCount: seen.size,
    eligibleCount: eligible.size,
    // Reported rather than papered over: M6 does not decide whether to re-show
    // seen videos - that is a product policy question, and it belongs to M7.
    exhausted: unseenEligible < requestedLimit,
  };
}
