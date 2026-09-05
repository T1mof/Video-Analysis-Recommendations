import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { events, users, videos } from '../db/schema.ts';
import type { SignalEvent } from './signals.ts';

/**
 * Interaction intake.
 *
 * The write path is deliberately thin: validate, append, deduplicate. Profile
 * recomputation is a separate call so the caller decides whether it happens
 * inline (MVP, one user, milliseconds) or on a queue (production).
 */

/**
 * Event types a client may send. Narrower than the database enum on purpose: see
 * the note on `type` below.
 */
export const ACCEPTED_EVENT_TYPES = [
  'impression',
  'view',
  'complete',
  'like',
  'skip',
  'dislike',
] as const;

export const interactionSchema = z.object({
  /**
   * Client-supplied idempotency key. Optional, because seeds and simulations
   * have no client, but strongly recommended for real clients: without it a
   * network retry becomes a second like.
   */
  eventId: z.string().min(1).max(200).optional(),
  userId: z.string().uuid(),
  videoId: z.string().uuid(),
  /**
   * `watch` is deliberately absent. It is a legacy enum value from the initial
   * schema with no producer, and it means the same thing as `view` - so a client
   * sending `view` on start and `watch` as a progress ping would contribute
   * +0.50 for a single playback, double what the weight table promises. One
   * canonical signal per meaning; stored `watch` rows still score normally.
   */
  type: z.enum(ACCEPTED_EVENT_TYPES),
  /** Fraction of the video watched, 0..1. Stored for M6 ranking, not used by the profile. */
  watchRatio: z.number().min(0).max(1).nullable().optional(),
  watchMs: z.number().int().min(0).nullable().optional(),
  /** Backdating exists for deterministic demos and tests, not for clients. */
  occurredAt: z.coerce.date().optional(),
});

export type InteractionInput = z.infer<typeof interactionSchema>;

export interface RecordResult {
  /** False when this eventId was already recorded - the call was a no-op. */
  recorded: boolean;
  eventId: string | null;
  type: SignalEvent;
}

export class UnknownReferenceError extends Error {
  constructor(readonly what: 'user' | 'video', id: string) {
    super(`Unknown ${what}: ${id}`);
    this.name = 'UnknownReferenceError';
  }
}

/**
 * Append one interaction.
 *
 * Idempotency is enforced by the unique index on `event_id` rather than by a
 * read-then-write check: two concurrent retries would both pass a check and both
 * insert. `onConflictDoNothing` lets the database settle it, and the returned row
 * count tells us which call won.
 */
export async function recordInteraction(input: InteractionInput): Promise<RecordResult> {
  const parsed = interactionSchema.parse(input);

  // Checked explicitly so the caller gets "unknown video" rather than a raw
  // foreign-key violation from Postgres.
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, parsed.userId));
  if (!user) throw new UnknownReferenceError('user', parsed.userId);
  const [video] = await db
    .select({ id: videos.id })
    .from(videos)
    .where(eq(videos.id, parsed.videoId));
  if (!video) throw new UnknownReferenceError('video', parsed.videoId);

  const inserted = await db
    .insert(events)
    .values({
      eventId: parsed.eventId ?? null,
      userId: parsed.userId,
      videoId: parsed.videoId,
      type: parsed.type,
      watchMs: parsed.watchMs ?? null,
      positionPct: parsed.watchRatio ?? null,
      ...(parsed.occurredAt ? { createdAt: parsed.occurredAt } : {}),
    })
    .onConflictDoNothing({ target: events.eventId })
    .returning({ id: events.id });

  return {
    recorded: inserted.length > 0,
    eventId: parsed.eventId ?? null,
    type: parsed.type,
  };
}

/** Every event this user has recorded against one video. Used by tests and debug. */
export async function interactionsFor(userId: string, videoId: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.videoId, videoId)));
}
