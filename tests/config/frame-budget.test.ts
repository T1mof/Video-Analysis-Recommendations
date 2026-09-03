import { describe, expect, it } from 'vitest';
import { env, frameBudgetFor } from '../../src/config/env.ts';

describe('frameBudgetFor', () => {
  it('spends fewer frames on short videos than long ones', () => {
    expect(frameBudgetFor(10)).toBeLessThan(frameBudgetFor(60));
    expect(frameBudgetFor(60)).toBeLessThan(frameBudgetFor(150));
  });

  it('is monotonically non-decreasing in duration', () => {
    let previous = 0;
    for (const seconds of [5, 20, 21, 45, 46, 90, 91, 180, 181, 600]) {
      const budget = frameBudgetFor(seconds);
      expect(budget).toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
  });

  it('never exceeds the hard cap, which is the cost ceiling per video', () => {
    for (const seconds of [1, 30, 120, 3600]) {
      expect(frameBudgetFor(seconds)).toBeLessThanOrEqual(env.FRAMES_MAX_BUDGET);
    }
  });

  it('uses tier boundaries inclusively', () => {
    expect(frameBudgetFor(env.FRAMES_BOUND_SHORT)).toBe(env.FRAMES_TIER_SHORT);
    expect(frameBudgetFor(env.FRAMES_BOUND_SHORT + 0.1)).toBe(env.FRAMES_TIER_MEDIUM);
  });
});
