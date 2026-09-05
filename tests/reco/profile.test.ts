import { describe, expect, it } from 'vitest';
import { computeProfile, type EventRow } from '../../src/reco/profile.ts';
import { encodeFeatures, topDimensions } from '../../src/analysis/embedding.ts';
import { TAXONOMY_DIM, describeSlot, slotIndex } from '../../src/analysis/taxonomy.ts';
import { makeFeatures } from '../fixtures.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-09-05T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

const OPTIONS = { now: NOW, halfLifeDays: 7, coldStartMinInteractions: 5 };

/** A video whose taxonomy vector we know, so dimensions can be asserted by name. */
const blondeBedroom = encodeFeatures(makeFeatures({ hairColor: 'blonde', setting: 'bedroom' }));
const darkOutdoor = encodeFeatures(makeFeatures({ hairColor: 'dark', setting: 'outdoor' }));

const BLONDE = slotIndex('hairColor', 'blonde')!;
const DARK = slotIndex('hairColor', 'dark')!;
const OUTDOOR = slotIndex('setting', 'outdoor')!;

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    type: 'like',
    createdAt: NOW,
    creatorId: 'creator_a',
    creatorHandle: 'creator_a',
    embedding: blondeBedroom,
    ...overrides,
  };
}

describe('computeProfile', () => {
  it('always produces a vector of exactly TAXONOMY_DIM dimensions', () => {
    expect(computeProfile('u', [], OPTIONS).vector).toHaveLength(TAXONOMY_DIM);
    expect(computeProfile('u', [event()], OPTIONS).vector).toHaveLength(TAXONOMY_DIM);
  });

  it('turns a like into a positive preference for that video\'s tags', () => {
    const profile = computeProfile('u', [event({ type: 'like' })], OPTIONS);
    expect(profile.vector[BLONDE]!).toBeGreaterThan(0);
    expect(profile.positiveSignal).toBeCloseTo(1, 10);
    expect(profile.negativeSignal).toBe(0);
  });

  it('turns a skip into a negative preference, not a missing one', () => {
    const profile = computeProfile('u', [event({ type: 'skip' })], OPTIONS);
    expect(profile.vector[BLONDE]!).toBeLessThan(0);
    expect(profile.negativeSignal).toBeCloseTo(0.5, 10);
  });

  it('moves in both directions at once: like up, dislike down', () => {
    const profile = computeProfile(
      'u',
      [
        event({ type: 'like', embedding: blondeBedroom }),
        event({ type: 'dislike', embedding: darkOutdoor }),
      ],
      OPTIONS,
    );
    expect(profile.vector[BLONDE]!).toBeGreaterThan(0);
    expect(profile.vector[DARK]!).toBeLessThan(0);
    // like (+1.0) and dislike (-1.0) are deliberately symmetric, so equal-age
    // opposites cancel to the same magnitude in opposite directions.
    expect(Math.abs(profile.vector[DARK]!)).toBeCloseTo(profile.vector[BLONDE]!, 10);
  });

  it('makes a dislike bite harder than a skip', () => {
    const disliked = computeProfile('u', [event({ type: 'dislike' })], OPTIONS);
    const skipped = computeProfile('u', [event({ type: 'skip' })], OPTIONS);
    expect(disliked.negativeSignal).toBeGreaterThan(skipped.negativeSignal);

    // Against the same competing like, the dislike wins by more.
    const withDislike = computeProfile(
      'u',
      [event({ type: 'like', embedding: blondeBedroom }), event({ type: 'dislike', embedding: darkOutdoor })],
      OPTIONS,
    );
    const withSkip = computeProfile(
      'u',
      [event({ type: 'like', embedding: blondeBedroom }), event({ type: 'skip', embedding: darkOutdoor })],
      OPTIONS,
    );
    expect(withDislike.vector[DARK]!).toBeLessThan(withSkip.vector[DARK]!);
  });

  it('does not scale the profile up when the same interaction repeats', () => {
    const once = computeProfile('u', [event()], OPTIONS);
    const twice = computeProfile('u', [event(), event()], OPTIONS);

    // Normalised by total signal mass, so repetition reinforces rather than inflates.
    expect(twice.vector[BLONDE]!).toBeCloseTo(once.vector[BLONDE]!, 10);
    expect(twice.effectiveSignalCount).toBe(2);
  });

  it('weights a fresh like above an identical week-old like', () => {
    const fresh = computeProfile('u', [event({ createdAt: NOW })], OPTIONS);
    const old = computeProfile('u', [event({ createdAt: daysAgo(7) })], OPTIONS);

    // A single event normalises to the same unit vector regardless of age - the
    // difference has to be visible where it matters, in the signal mass and in
    // how it competes with other events.
    expect(fresh.positiveSignal).toBeCloseTo(1, 10);
    expect(old.positiveSignal).toBeCloseTo(0.5, 10);

    const mixed = computeProfile(
      'u',
      [
        event({ createdAt: NOW, embedding: blondeBedroom }),
        event({ createdAt: daysAgo(7), embedding: darkOutdoor }),
      ],
      OPTIONS,
    );
    expect(mixed.vector[BLONDE]!).toBeGreaterThan(mixed.vector[DARK]!);
  });

  it('ignores impressions entirely', () => {
    const profile = computeProfile(
      'u',
      [event({ type: 'impression' }), event({ type: 'impression' })],
      OPTIONS,
    );
    expect(profile.effectiveSignalCount).toBe(0);
    expect(profile.interactionCount).toBe(2);
    expect(profile.vector.every((v) => v === 0)).toBe(true);
    expect(profile.creatorAffinity).toHaveLength(0);
  });

  describe('cold start', () => {
    it('stays cold below the threshold', () => {
      for (let n = 0; n < 5; n++) {
        const rows = Array.from({ length: n }, () => event());
        expect(computeProfile('u', rows, OPTIONS).isColdStart).toBe(true);
      }
    });

    it('warms up at the threshold', () => {
      const rows = Array.from({ length: 5 }, () => event());
      const profile = computeProfile('u', rows, OPTIONS);
      expect(profile.effectiveSignalCount).toBe(5);
      expect(profile.isColdStart).toBe(false);
    });

    it('is not warmed by impressions, however many', () => {
      const rows = Array.from({ length: 50 }, () => event({ type: 'impression' }));
      expect(computeProfile('u', rows, OPTIONS).isColdStart).toBe(true);
    });

    it('is not warmed by interactions with unanalysed videos', () => {
      const rows = Array.from({ length: 10 }, () => event({ embedding: null }));
      const profile = computeProfile('u', rows, OPTIONS);
      expect(profile.isColdStart).toBe(true);
      expect(profile.skippedNoFeatures).toBe(10);
    });
  });

  describe('videos without features', () => {
    it('counts them, excludes them, and leaves the vector clean', () => {
      const profile = computeProfile(
        'u',
        [event({ embedding: null }), event({ embedding: blondeBedroom })],
        OPTIONS,
      );
      expect(profile.skippedNoFeatures).toBe(1);
      expect(profile.effectiveSignalCount).toBe(1);
      expect(profile.vector).toHaveLength(TAXONOMY_DIM);
      expect(profile.vector.every(Number.isFinite)).toBe(true);
    });

    it('rejects a vector of the wrong dimension rather than corrupting the profile', () => {
      const profile = computeProfile('u', [event({ embedding: [1, 2, 3] })], OPTIONS);
      expect(profile.skippedNoFeatures).toBe(1);
      expect(profile.vector.every((v) => v === 0)).toBe(true);
    });

    it('produces a zero vector, not NaN, when nothing is usable', () => {
      const profile = computeProfile('u', [event({ embedding: null })], OPTIONS);
      expect(profile.vector.every((v) => v === 0)).toBe(true);
    });
  });

  describe('creator affinity', () => {
    it('is positive for a liked creator and negative for a skipped one', () => {
      const profile = computeProfile(
        'u',
        [
          event({ type: 'like', creatorId: 'a', creatorHandle: 'a' }),
          event({ type: 'skip', creatorId: 'b', creatorHandle: 'b' }),
        ],
        OPTIONS,
      );
      const byId = new Map(profile.creatorAffinity.map((c) => [c.creatorId, c.score]));
      expect(byId.get('a')!).toBeGreaterThan(0);
      expect(byId.get('b')!).toBeLessThan(0);
    });

    it('is sorted strongest first and shares the profile denominator', () => {
      const profile = computeProfile(
        'u',
        [
          event({ type: 'like', creatorId: 'a', creatorHandle: 'a' }),
          event({ type: 'view', creatorId: 'b', creatorHandle: 'b' }),
        ],
        OPTIONS,
      );
      expect(profile.creatorAffinity[0]!.creatorId).toBe('a');
      // 1.0 / (1.0 + 0.25)
      expect(profile.creatorAffinity[0]!.score).toBeCloseTo(0.8, 10);
    });

    it('skips videos with no creator rather than inventing one', () => {
      const profile = computeProfile(
        'u',
        [event({ creatorId: null, creatorHandle: null })],
        OPTIONS,
      );
      expect(profile.creatorAffinity).toHaveLength(0);
      expect(profile.effectiveSignalCount).toBe(1);
    });
  });
});

describe('explainability', () => {
  it('names dimensions through the frozen taxonomy layout', () => {
    const profile = computeProfile('u', [event({ type: 'like' })], OPTIONS);
    // All of them: hairColor carries a lower taxonomy weight than actType, so it
    // legitimately does not make the top five.
    const all = topDimensions(profile.vector, TAXONOMY_DIM, 'positive');

    expect(all.length).toBeGreaterThan(0);
    expect(all.map((t) => t.dimension)).toContain(describeSlot(BLONDE));
    expect(all.every((t) => t.dimension.includes(':'))).toBe(true);
    // Sorted strongest first.
    expect(all[0]!.contribution).toBeGreaterThanOrEqual(all.at(-1)!.contribution);
    expect(topDimensions(profile.vector, 5, 'positive')).toHaveLength(5);
  });

  it('returns the dislikes when asked for the negative direction', () => {
    const profile = computeProfile(
      'u',
      [event({ type: 'dislike', embedding: darkOutdoor })],
      OPTIONS,
    );
    const negative = topDimensions(profile.vector, TAXONOMY_DIM, 'negative');

    expect(negative.map((t) => t.dimension)).toContain(describeSlot(OUTDOOR));
    expect(negative.every((t) => t.contribution < 0)).toBe(true);
    // Most negative first.
    expect(negative[0]!.contribution).toBeLessThanOrEqual(negative.at(-1)!.contribution);
    // A purely negative profile has no positive side at all.
    expect(topDimensions(profile.vector, 5, 'positive')).toHaveLength(0);
  });

  it('never reports an "unknown" value as a preference', () => {
    const profile = computeProfile(
      'u',
      [event({ embedding: encodeFeatures(makeFeatures({ hairColor: 'unknown' })) })],
      OPTIONS,
    );
    const named = [
      ...topDimensions(profile.vector, TAXONOMY_DIM, 'positive'),
      ...topDimensions(profile.vector, TAXONOMY_DIM, 'negative'),
    ].map((t) => t.dimension);

    expect(named).not.toContain('hairColor:unknown');
  });
});
