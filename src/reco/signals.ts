import { env } from '../config/env.ts';

/**
 * Interaction signals: how a user's behaviour becomes a number.
 *
 * Everything that turns an event into profile influence lives here, and nowhere
 * else. Weights scattered across a worker, a route handler and a script drift
 * apart within a week and make the profile impossible to reason about; a single
 * table can be read, argued with and tuned in one place.
 *
 * These stay constants rather than environment variables on purpose. Six knobs
 * nobody will turn during a one-week MVP add deployment surface without adding
 * capability, and the two values that genuinely are policy - the decay half-life
 * and the cold-start threshold - already exist in env.
 */

export type SignalEvent =
  | 'impression'
  | 'view'
  | 'watch'
  | 'complete'
  | 'like'
  | 'skip'
  | 'dislike';

/**
 * Signed influence per event type.
 *
 * The scale is deliberately blunt: one like outweighs one skip, two skips
 * outweigh one like, and an impression counts for nothing at all.
 */
export const EVENT_WEIGHTS: Readonly<Record<SignalEvent, number>> = {
  /** Shown, not chosen. Records exposure; says nothing about interest. */
  impression: 0.0,
  /** Started or continued watching. Weak positive. */
  view: 0.25,
  /**
   * Legacy. Same meaning as `view`, kept only so rows written against the
   * original M1 enum still score. The intake schema does NOT accept it: two
   * accepted event types meaning "started watching" would let one playback
   * contribute +0.50 by emitting both. Use `view`.
   */
  watch: 0.25,
  /** Watched to the end. Stronger positive. */
  complete: 0.6,
  /** Explicit approval. Strongest positive. */
  like: 1.0,
  /** Dismissed quickly. Negative - the profile must be able to move down. */
  skip: -0.5,
  /** Explicit rejection. Strongest negative. */
  dislike: -1.0,
};

export function eventWeight(type: SignalEvent): number {
  return EVENT_WEIGHTS[type] ?? 0;
}

/** An event whose weight is zero cannot move the profile in any direction. */
export function isMeaningful(type: SignalEvent): boolean {
  return eventWeight(type) !== 0;
}

const MS_PER_DAY = 86_400_000;

export function ageInDays(at: Date, now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - at.getTime()) / MS_PER_DAY);
}

/**
 * Exponential time decay: `0.5 ^ (ageDays / halfLife)`.
 *
 *   now      1.000
 *   7 days   0.500
 *   14 days  0.250
 *   21 days  0.125
 *
 * Exponential rather than linear because linear decay has a cliff - an event one
 * day past the window is worth nothing while an event one day inside it is worth
 * something - and because taste fades gradually rather than expiring. It is also
 * self-limiting: old events never quite reach zero but stop mattering, so the
 * profile keeps a faint memory of long-term preference while tracking recent
 * behaviour.
 */
export function decay(ageDays: number, halfLifeDays: number = env.PROFILE_HALFLIFE_DAYS): number {
  if (halfLifeDays <= 0) return 1;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/**
 * The signed, time-decayed influence of one event.
 *
 * `signal = eventWeight(type) x decay(age)`
 */
export function signalStrength(
  type: SignalEvent,
  at: Date,
  now: Date = new Date(),
  halfLifeDays: number = env.PROFILE_HALFLIFE_DAYS,
): number {
  return eventWeight(type) * decay(ageInDays(at, now), halfLifeDays);
}

/** Guards the normalisation denominator against a division by zero. */
export const SIGNAL_EPSILON = 1e-9;
