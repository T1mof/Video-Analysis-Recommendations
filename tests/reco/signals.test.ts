import { describe, expect, it } from 'vitest';
import {
  EVENT_WEIGHTS,
  ageInDays,
  decay,
  eventWeight,
  isMeaningful,
  signalStrength,
} from '../../src/reco/signals.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-09-05T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

describe('decay', () => {
  it('halves every half-life', () => {
    expect(decay(0, 7)).toBeCloseTo(1, 10);
    expect(decay(7, 7)).toBeCloseTo(0.5, 10);
    expect(decay(14, 7)).toBeCloseTo(0.25, 10);
    expect(decay(21, 7)).toBeCloseTo(0.125, 10);
  });

  it('is exponential rather than linear - no cliff at the window edge', () => {
    // A linear 14-day decay would hit exactly 0 at 14 days and go negative after.
    expect(decay(14, 7)).toBeGreaterThan(0);
    expect(decay(60, 7)).toBeGreaterThan(0);
    expect(decay(60, 7)).toBeLessThan(0.01);
  });

  it('treats a future timestamp as the present rather than amplifying it', () => {
    expect(decay(-5, 7)).toBe(1);
    expect(ageInDays(new Date(NOW.getTime() + 10 * DAY), NOW)).toBe(0);
  });

  it('never divides by a zero half-life', () => {
    expect(decay(10, 0)).toBe(1);
  });
});

describe('event weights', () => {
  it('orders the signals the way the product means them', () => {
    expect(EVENT_WEIGHTS.like).toBeGreaterThan(EVENT_WEIGHTS.complete);
    expect(EVENT_WEIGHTS.complete).toBeGreaterThan(EVENT_WEIGHTS.view);
    expect(EVENT_WEIGHTS.view).toBeGreaterThan(EVENT_WEIGHTS.impression);
    expect(EVENT_WEIGHTS.skip).toBeLessThan(0);
    expect(EVENT_WEIGHTS.dislike).toBeLessThan(EVENT_WEIGHTS.skip);
  });

  it('gives an impression no weight, so exposure is not interest', () => {
    expect(eventWeight('impression')).toBe(0);
    expect(isMeaningful('impression')).toBe(false);
    expect(isMeaningful('like')).toBe(true);
    expect(isMeaningful('skip')).toBe(true);
  });

  it('still scores legacy watch rows at the view weight', () => {
    // Kept scoreable for rows written against the original enum; the intake
    // schema refuses it so one playback cannot pay twice (see interactions.ts).
    expect(eventWeight('watch')).toBe(eventWeight('view'));
  });
});

describe('signalStrength', () => {
  it('combines weight and decay', () => {
    expect(signalStrength('like', NOW, NOW, 7)).toBeCloseTo(1, 10);
    expect(signalStrength('like', daysAgo(7), NOW, 7)).toBeCloseTo(0.5, 10);
    expect(signalStrength('skip', daysAgo(7), NOW, 7)).toBeCloseTo(-0.25, 10);
  });

  it('keeps a fresh like stronger than an old one', () => {
    expect(signalStrength('like', NOW, NOW, 7)).toBeGreaterThan(
      signalStrength('like', daysAgo(7), NOW, 7),
    );
  });

  it('stays zero for impressions no matter how recent', () => {
    expect(signalStrength('impression', NOW, NOW, 7)).toBe(0);
  });
});
