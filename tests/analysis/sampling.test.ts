import { describe, expect, it } from 'vitest';
import {
  defaultPolicy,
  frameBudgetFor,
  planTimestamps,
  snapToScenes,
  type SamplingPolicy,
} from '../../src/analysis/sampling.ts';
import { env } from '../../src/config/env.ts';

const policy: SamplingPolicy = defaultPolicy();

describe('frameBudgetFor', () => {
  it('follows the configured duration tiers', () => {
    expect(frameBudgetFor(15)).toBe(policy.tierShort); // <= 30s
    expect(frameBudgetFor(45)).toBe(policy.tierMedium); // <= 60s
    expect(frameBudgetFor(90)).toBe(policy.tierLong); // <= 120s
    expect(frameBudgetFor(300)).toBe(policy.tierMax); // longer
  });

  it('treats tier boundaries inclusively', () => {
    expect(frameBudgetFor(30)).toBe(policy.tierShort);
    expect(frameBudgetFor(30.1)).toBe(policy.tierMedium);
    expect(frameBudgetFor(60)).toBe(policy.tierMedium);
    expect(frameBudgetFor(60.1)).toBe(policy.tierLong);
    expect(frameBudgetFor(120)).toBe(policy.tierLong);
    expect(frameBudgetFor(120.1)).toBe(policy.tierMax);
  });

  it('is monotonically non-decreasing in duration', () => {
    let previous = 0;
    for (const seconds of [6, 10, 30, 31, 60, 61, 120, 121, 600, 3600]) {
      const budget = frameBudgetFor(seconds);
      expect(budget).toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
  });

  it('never exceeds MAX_ANALYSIS_FRAMES - the per-video cost ceiling', () => {
    for (const seconds of [1, 30, 120, 600, 36_000]) {
      expect(frameBudgetFor(seconds)).toBeLessThanOrEqual(env.MAX_ANALYSIS_FRAMES);
    }
    expect(env.MAX_ANALYSIS_FRAMES).toBe(16);
  });

  it('caps at the hard limit even if a tier is misconfigured above it', () => {
    const reckless: SamplingPolicy = { ...policy, tierMax: 500, maxFrames: 16 };
    expect(frameBudgetFor(600, reckless)).toBe(16);
  });

  it('scales down for very short videos instead of demanding 6 frames from 2s', () => {
    expect(frameBudgetFor(2)).toBeLessThanOrEqual(2);
    expect(frameBudgetFor(1)).toBe(1);
    expect(frameBudgetFor(5)).toBeLessThanOrEqual(5);
  });

  it('handles nonsense durations without throwing', () => {
    expect(frameBudgetFor(0)).toBe(1);
    expect(frameBudgetFor(-10)).toBe(1);
    expect(frameBudgetFor(Number.NaN)).toBe(1);
  });
});

describe('planTimestamps', () => {
  it('is deterministic', () => {
    expect(planTimestamps(42.6, 8)).toEqual(planTimestamps(42.6, 8));
  });

  it('never samples exactly at 0, which is usually a black frame or title card', () => {
    for (const duration of [5, 20, 42.6, 104.6]) {
      const timestamps = planTimestamps(duration, frameBudgetFor(duration));
      expect(timestamps[0]).toBeGreaterThan(0);
    }
  });

  it('stays strictly inside the video', () => {
    const duration = 42.6;
    for (const timestamp of planTimestamps(duration, 8)) {
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThan(duration);
    }
  });

  it('returns ascending, distinct timestamps', () => {
    const timestamps = planTimestamps(60, 8);
    expect(timestamps).toHaveLength(8);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThan(timestamps[i - 1]!);
    }
  });

  it('covers beginning, middle and end rather than clustering', () => {
    const duration = 100;
    const timestamps = planTimestamps(duration, 8);
    // First sample in the opening third, last in the closing third.
    expect(timestamps[0]!).toBeLessThan(duration / 3);
    expect(timestamps.at(-1)!).toBeGreaterThan((duration * 2) / 3);

    // Spacing is near-uniform: no gap is more than twice the smallest.
    const gaps: number[] = [];
    for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i]! - timestamps[i - 1]!);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(2);
  });

  it('handles a very short video without collapsing to one instant', () => {
    const timestamps = planTimestamps(2, frameBudgetFor(2));
    expect(timestamps.length).toBeGreaterThanOrEqual(1);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    for (const t of timestamps) expect(t).toBeLessThan(2);
  });

  it('returns nothing for a zero or negative duration', () => {
    expect(planTimestamps(0, 6)).toEqual([]);
    expect(planTimestamps(-5, 6)).toEqual([]);
    expect(planTimestamps(30, 0)).toEqual([]);
  });

  it('produces exactly the requested count on a normal video', () => {
    for (const [duration, count] of [
      [20, 6],
      [45, 8],
      [90, 12],
      [200, 16],
    ] as const) {
      expect(planTimestamps(duration, count)).toHaveLength(count);
    }
  });
});

describe('snapToScenes', () => {
  it('leaves timestamps untouched when there are no cuts', () => {
    const timestamps = planTimestamps(60, 8);
    expect(snapToScenes(timestamps, [])).toEqual(timestamps);
  });

  it('moves a timestamp onto a nearby cut, landing just after it', () => {
    const [snapped] = snapToScenes([10], [9.5], 1.5);
    expect(snapped).toBeGreaterThan(9.5);
    expect(snapped).toBeLessThan(10.5);
  });

  it('ignores cuts outside the snap window', () => {
    expect(snapToScenes([10], [3], 1.5)).toEqual([10]);
  });

  it('does not increase the frame count, whatever the cut density', () => {
    const timestamps = planTimestamps(60, 8);
    const manyCuts = Array.from({ length: 200 }, (_, i) => i * 0.3);
    // A fast-cut video must not blow the budget by adopting the cut list.
    expect(snapToScenes(timestamps, manyCuts).length).toBeLessThanOrEqual(timestamps.length);
  });

  it('returns ascending timestamps', () => {
    const result = snapToScenes(planTimestamps(60, 8), [12, 25, 41]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!).toBeGreaterThan(result[i - 1]!);
    }
  });
});
