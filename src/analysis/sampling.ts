import { env } from '../config/env.ts';

/**
 * Adaptive frame sampling - the decision that sets analysis cost.
 *
 * A VLM is billed for frames x pixels-per-frame, so choosing *which* handful of
 * frames represents a video is the difference between an affordable pipeline and
 * an unaffordable one. Decoding every frame of 100k videos is never on the table:
 * these functions pick a small, evenly spread, deterministic set instead.
 *
 * Everything here is pure and side-effect free, so the policy can be tested and
 * tuned without touching ffmpeg, S3 or a model.
 */

export interface SamplingPolicy {
  tierShort: number;
  tierMedium: number;
  tierLong: number;
  tierMax: number;
  boundShort: number;
  boundMedium: number;
  boundLong: number;
  maxFrames: number;
  headTailTrimPct: number;
}

export function defaultPolicy(): SamplingPolicy {
  return {
    tierShort: env.FRAMES_TIER_SHORT,
    tierMedium: env.FRAMES_TIER_MEDIUM,
    tierLong: env.FRAMES_TIER_LONG,
    tierMax: env.FRAMES_TIER_MAX,
    boundShort: env.FRAMES_BOUND_SHORT,
    boundMedium: env.FRAMES_BOUND_MEDIUM,
    boundLong: env.FRAMES_BOUND_LONG,
    maxFrames: env.MAX_ANALYSIS_FRAMES,
    headTailTrimPct: env.HEAD_TAIL_TRIM_PCT,
  };
}

/**
 * How many frames a video of this duration is worth.
 *
 * Step function rather than something continuous because the tiers are a budget
 * decision a human makes and audits, not a curve to tune. The hard cap is applied
 * last so no configuration mistake can produce an unbounded bill.
 */
export function frameBudgetFor(
  durationSeconds: number,
  policy: SamplingPolicy = defaultPolicy(),
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1;

  const tier =
    durationSeconds <= policy.boundShort
      ? policy.tierShort
      : durationSeconds <= policy.boundMedium
        ? policy.tierMedium
        : durationSeconds <= policy.boundLong
          ? policy.tierLong
          : policy.tierMax;

  const capped = Math.min(tier, policy.maxFrames);

  // A 3-second clip cannot usefully yield 6 distinct frames. Roughly one frame per
  // second is the floor below which sampling starts returning near-identical
  // images that de-duplication would discard anyway.
  const feasible = Math.max(1, Math.floor(durationSeconds));

  return Math.max(1, Math.min(capped, feasible));
}

/**
 * Evenly spread timestamps across the usable middle of the video.
 *
 * Uses the midpoint rule - duration * (i + 0.5) / n - rather than endpoints,
 * because t=0 is very often a black frame, a fade-in or a title card, and the last
 * instant is often an end card. Both would spend budget on frames that say nothing
 * about the content.
 *
 * A head/tail trim narrows the window further on longer videos. Deterministic: the
 * same duration and count always produce the same timestamps.
 */
export function planTimestamps(
  durationSeconds: number,
  count: number,
  policy: SamplingPolicy = defaultPolicy(),
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (count <= 0) return [];

  const trim = Math.min(Math.max(policy.headTailTrimPct, 0), 0.45);
  let start = durationSeconds * trim;
  let end = durationSeconds * (1 - trim);

  // On a very short clip the trim can collapse the window; fall back to the whole
  // thing rather than sampling a single instant repeatedly.
  if (!(end > start)) {
    start = 0;
    end = durationSeconds;
  }

  const span = end - start;
  const timestamps: number[] = [];

  for (let i = 0; i < count; i++) {
    const position = start + (span * (i + 0.5)) / count;
    // Keep a safety margin off the final frame: seeking exactly to the duration
    // lands past the last decodable frame in many containers.
    const clamped = Math.min(position, Math.max(durationSeconds - 0.05, 0));
    timestamps.push(round3(Math.max(clamped, 0)));
  }

  // Two requested frames can round to the same instant on a sub-second clip.
  return [...new Set(timestamps)];
}

/**
 * Nudges uniform timestamps toward nearby scene cuts.
 *
 * Only ever moves a timestamp within `snapWindow`, and only forward past the cut,
 * so a frame lands inside the new scene rather than on the transition itself. The
 * uniform spread is preserved - this refines placement, it does not replace the
 * plan with the cut list, which on a fast-cut video would blow the budget.
 */
export function snapToScenes(
  timestamps: readonly number[],
  sceneChanges: readonly number[],
  snapWindowSeconds: number = env.SCENE_SNAP_WINDOW_SECONDS,
): number[] {
  if (sceneChanges.length === 0 || snapWindowSeconds <= 0) return [...timestamps];

  const cuts = [...sceneChanges].sort((a, b) => a - b);
  const used = new Set<number>();
  const result: number[] = [];

  for (const timestamp of timestamps) {
    let best = timestamp;
    let bestDistance = Infinity;

    for (const cut of cuts) {
      // Land just after the cut: the frame at the cut itself is often a blend.
      const candidate = round3(cut + 0.15);
      const distance = Math.abs(candidate - timestamp);
      if (distance <= snapWindowSeconds && distance < bestDistance && !used.has(candidate)) {
        best = candidate;
        bestDistance = distance;
      }
    }

    used.add(best);
    result.push(best);
  }

  return [...new Set(result)].sort((a, b) => a - b);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
