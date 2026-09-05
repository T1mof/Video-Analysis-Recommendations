import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  events,
  userCreatorAffinity,
  userProfiles,
  videoEmbeddings,
  videos,
} from '../db/schema.ts';
import { TAXONOMY_DIM, TAXONOMY_VERSION } from '../analysis/taxonomy.ts';
import { addScaled, toTagAffinity, zeroVector } from '../analysis/embedding.ts';
import { env } from '../config/env.ts';
import {
  SIGNAL_EPSILON,
  type SignalEvent,
  eventWeight,
  isMeaningful,
  signalStrength,
} from './signals.ts';

/**
 * User preference profile.
 *
 *   signal_i = eventWeight(type_i) x decay(age_i)
 *   P        = sum(signal_i x v_i) / max(sum(|signal_i|), epsilon)
 *
 * where v_i is the video's 110-dimension taxonomy vector.
 *
 * Why divide by the sum of absolute signals
 * -----------------------------------------
 * Without it the vector's magnitude grows with activity, so a heavy user and a
 * light user with identical taste would produce different-length vectors and any
 * threshold tuned on one would be wrong for the other. Dividing by the total
 * signal mass makes the profile a weighted *average* of the content the user
 * reacted to, which is comparable across users. It also means repeating the same
 * interaction does not inflate the profile - it reinforces it.
 *
 * Absolute value, not the raw sum: a user with one like and one skip has a total
 * signal of 0.5, not 0. A signed denominator could be near zero (or negative) for
 * a balanced user and would blow the vector up.
 *
 * Why negatives survive
 * ---------------------
 * Dimensions are left negative rather than clamped at zero. A profile that can
 * only accumulate positives drifts toward whatever it has already been shown and
 * cannot recover from a bad streak, because nothing pushes a preference back
 * down. M6 reads those negative dimensions as active dislikes.
 *
 * This is deterministic and interpretable - no model, no training. Rebuilding
 * from the same history always produces the same vector, which is what makes the
 * "why was this recommended" panel trustworthy.
 */

export interface CreatorAffinity {
  creatorId: string;
  creatorHandle: string | null;
  score: number;
  interactionCount: number;
}

export interface UserProfile {
  userId: string;
  taxonomyVersion: number;
  vector: number[];
  /** Every event on record, impressions included. */
  interactionCount: number;
  /** Events that could move the profile: non-zero weight and analysed video. */
  effectiveSignalCount: number;
  positiveSignal: number;
  negativeSignal: number;
  /** Events whose video has no analysed features; counted, never encoded. */
  skippedNoFeatures: number;
  isColdStart: boolean;
  creatorAffinity: CreatorAffinity[];
}

export interface EventRow {
  type: SignalEvent;
  createdAt: Date;
  creatorId: string | null;
  creatorHandle: string | null;
  /** Null when the video has never been analysed. */
  embedding: number[] | null;
}

export interface BuildOptions {
  /** Injectable clock so decay is testable without waiting a week. */
  now?: Date;
  halfLifeDays?: number;
  coldStartMinInteractions?: number;
}

/**
 * Pure core: history in, profile out. No database, no clock of its own.
 *
 * Kept separate from the persistence wrapper so the formula can be tested
 * directly, and so a future streaming consumer can reuse it unchanged.
 */
export function computeProfile(
  userId: string,
  rows: readonly EventRow[],
  options: BuildOptions = {},
): UserProfile {
  const now = options.now ?? new Date();
  const halfLife = options.halfLifeDays ?? env.PROFILE_HALFLIFE_DAYS;
  const coldStartMin = options.coldStartMinInteractions ?? env.COLD_START_MIN_INTERACTIONS;

  const accumulator = zeroVector();
  let totalAbsSignal = 0;
  let positiveSignal = 0;
  let negativeSignal = 0;
  let effectiveSignalCount = 0;
  let skippedNoFeatures = 0;

  const creatorSignal = new Map<string, { signal: number; count: number; handle: string | null }>();

  for (const row of rows) {
    if (!isMeaningful(row.type)) continue;

    // An interaction with an unanalysed video is real behaviour but carries no
    // content: there is no vector to point the profile at. It is counted so the
    // gap is visible, and deliberately not substituted with mock features, which
    // would silently teach the profile things the user never expressed.
    if (!row.embedding || row.embedding.length !== TAXONOMY_DIM) {
      skippedNoFeatures++;
      continue;
    }

    const signal = signalStrength(row.type, row.createdAt, now, halfLife);
    if (signal === 0) continue;

    addScaled(accumulator, row.embedding, signal);
    totalAbsSignal += Math.abs(signal);
    if (signal > 0) positiveSignal += signal;
    else negativeSignal += Math.abs(signal);
    effectiveSignalCount++;

    if (row.creatorId) {
      const entry = creatorSignal.get(row.creatorId) ?? {
        signal: 0,
        count: 0,
        handle: row.creatorHandle,
      };
      entry.signal += signal;
      entry.count++;
      creatorSignal.set(row.creatorId, entry);
    }
  }

  const denominator = Math.max(totalAbsSignal, SIGNAL_EPSILON);
  const vector = accumulator.map((v) => v / denominator);

  // Creator affinity shares the profile's denominator so the two are on the same
  // scale: a creator whose videos carry all of a user's positive signal scores
  // ~1.0, and one the user only ever skips scores negative.
  const creatorAffinity: CreatorAffinity[] = [...creatorSignal.entries()]
    .map(([creatorId, entry]) => ({
      creatorId,
      creatorHandle: entry.handle,
      score: entry.signal / denominator,
      interactionCount: entry.count,
    }))
    .sort((a, b) => b.score - a.score);

  return {
    userId,
    taxonomyVersion: TAXONOMY_VERSION,
    vector,
    interactionCount: rows.length,
    effectiveSignalCount,
    positiveSignal,
    negativeSignal,
    skippedNoFeatures,
    isColdStart: effectiveSignalCount < coldStartMin,
    creatorAffinity,
  };
}

/** Reads one user's whole history joined to the content vectors it points at. */
async function loadHistory(userId: string): Promise<EventRow[]> {
  const rows = await db
    .select({
      type: events.type,
      createdAt: events.createdAt,
      creatorId: videos.creatorId,
      creatorHandle: videos.creatorHandle,
      embedding: videoEmbeddings.embedding,
    })
    .from(events)
    .innerJoin(videos, eq(videos.id, events.videoId))
    .leftJoin(videoEmbeddings, eq(videoEmbeddings.videoId, events.videoId))
    .where(eq(events.userId, userId));

  return rows.map((row) => ({
    type: row.type as SignalEvent,
    createdAt: row.createdAt,
    creatorId: row.creatorId,
    creatorHandle: row.creatorHandle,
    embedding: row.embedding,
  }));
}

/**
 * Rebuild a profile from the user's full history and persist it.
 *
 * Full recomputation is the right MVP choice: one user's history is small, the
 * result is exactly reproducible, and there is no incremental state to drift out
 * of sync. It does not scale to millions of users - the production path is an
 * event stream into an incremental profile consumer, described in
 * ARCHITECTURE.md - but the formula above is unchanged by that move.
 */
export async function rebuildUserProfile(
  userId: string,
  options: BuildOptions = {},
): Promise<UserProfile> {
  const history = await loadHistory(userId);
  const profile = computeProfile(userId, history, options);
  await persistProfile(profile);
  return profile;
}

async function persistProfile(profile: UserProfile): Promise<void> {
  const row = {
    userId: profile.userId,
    taxonomyVersion: profile.taxonomyVersion,
    embedding: profile.vector,
    tagAffinity: toTagAffinity(profile.vector),
    interactionCount: profile.interactionCount,
    effectiveSignalCount: profile.effectiveSignalCount,
    positiveSignal: profile.positiveSignal,
    negativeSignal: profile.negativeSignal,
    skippedNoFeatures: profile.skippedNoFeatures,
    isColdStart: profile.isColdStart,
    updatedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    await tx
      .insert(userProfiles)
      .values(row)
      .onConflictDoUpdate({ target: userProfiles.userId, set: row });

    // Replace rather than merge: the affinity table is a projection of history,
    // and a creator the user no longer interacts with must not keep a stale score.
    await tx.delete(userCreatorAffinity).where(eq(userCreatorAffinity.userId, profile.userId));
    if (profile.creatorAffinity.length > 0) {
      await tx.insert(userCreatorAffinity).values(
        profile.creatorAffinity.map((c) => ({
          userId: profile.userId,
          creatorId: c.creatorId,
          score: c.score,
          interactionCount: c.interactionCount,
          updatedAt: row.updatedAt,
        })),
      );
    }
  });
}

/** Reads a stored profile without recomputing it - the path M6 will use. */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const [stored] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  if (!stored) return null;

  const affinity = await db
    .select({
      creatorId: userCreatorAffinity.creatorId,
      score: userCreatorAffinity.score,
      interactionCount: userCreatorAffinity.interactionCount,
      creatorHandle: sql<string | null>`(
        select ${videos.creatorHandle} from ${videos}
        where ${videos.creatorId} = ${userCreatorAffinity.creatorId} limit 1
      )`,
    })
    .from(userCreatorAffinity)
    .where(eq(userCreatorAffinity.userId, userId))
    .orderBy(sql`${userCreatorAffinity.score} desc`);

  return {
    userId: stored.userId,
    taxonomyVersion: stored.taxonomyVersion,
    vector: stored.embedding,
    interactionCount: stored.interactionCount,
    effectiveSignalCount: stored.effectiveSignalCount,
    positiveSignal: stored.positiveSignal,
    negativeSignal: stored.negativeSignal,
    skippedNoFeatures: stored.skippedNoFeatures,
    isColdStart: stored.isColdStart,
    creatorAffinity: affinity,
  };
}

export { eventWeight };
