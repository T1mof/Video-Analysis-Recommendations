import { describe, expect, it } from 'vitest';
import { compareToGold, goldDatasetSchema, summarize } from '../../src/analysis/gold.ts';
import type { GoldLabel } from '../../src/analysis/gold.ts';
import { makeFeatures } from '../fixtures.ts';

function makeGold(overrides: Partial<GoldLabel['labels']> = {}): GoldLabel {
  const { aestheticScore: _a, caption: _c, confidence: _cf, ...labels } = makeFeatures();
  return { videoId: 'video-1', labels: { ...labels, ...overrides } };
}

describe('compareToGold', () => {
  it('scores a perfect match at 1 with no misses or hallucinations', () => {
    const result = compareToGold(makeFeatures(), makeGold());
    expect(result.macroScore).toBe(1);
    expect(result.spuriousCount).toBe(0);
    expect(result.missedCount).toBe(0);
  });

  it('reports a wrong single-value field as zero for that field only', () => {
    const result = compareToGold(makeFeatures({ setting: 'outdoor' }), makeGold());
    const setting = result.perField.find((f) => f.field === 'setting')!;
    expect(setting.score).toBe(0);
    expect(setting.spurious).toEqual(['outdoor']);
    expect(setting.missed).toEqual(['bedroom']);
    expect(result.macroScore).toBeGreaterThan(0.8);
  });

  it('separates hallucinated tags from missed tags', () => {
    // Model saw 'dancing' (not in gold) and failed to see 'posing' (in gold).
    const result = compareToGold(makeFeatures({ actType: ['dancing'] }), makeGold());
    const act = result.perField.find((f) => f.field === 'actType')!;
    expect(act.spurious).toEqual(['dancing']);
    expect(act.missed).toEqual(['posing']);
    expect(act.score).toBe(0);
  });

  it('gives partial credit for partial multi-value overlap', () => {
    const result = compareToGold(
      makeFeatures({ actType: ['posing', 'dancing'] }),
      makeGold({ actType: ['posing'] }),
    );
    const act = result.perField.find((f) => f.field === 'actType')!;
    expect(act.score).toBeCloseTo(0.5, 10); // |{posing}| / |{posing, dancing}|
  });

  it('treats two empty multi-value fields as agreement, not a divide by zero', () => {
    const result = compareToGold(makeFeatures({ fetishTags: [] }), makeGold({ fetishTags: [] }));
    const fetish = result.perField.find((f) => f.field === 'fetishTags')!;
    expect(fetish.score).toBe(1);
  });
});

describe('summarize', () => {
  it('averages per video and exposes which field a model is weakest on', () => {
    const results = [
      compareToGold(makeFeatures({ setting: 'outdoor' }), makeGold()),
      compareToGold(makeFeatures({ setting: 'pool' }), makeGold()),
    ];
    const summary = summarize(results);
    expect(summary.videos).toBe(2);
    expect(summary.byField.setting).toBe(0);
    expect(summary.byField.hairColor).toBe(1);
    expect(summary.totalSpurious).toBe(2);
  });

  it('handles an empty result set without producing NaN', () => {
    const summary = summarize([]);
    expect(summary.videos).toBe(0);
    expect(summary.macroScore).toBe(0);
  });
});

describe('goldDatasetSchema', () => {
  it('rejects labels containing a value outside the taxonomy', () => {
    const dataset = {
      taxonomyVersion: 1,
      reviewedBy: 'reviewer',
      reviewedAt: '2026-09-04',
      items: [makeGold({ hairColor: ['platinum_blonde'] as never })],
    };
    expect(goldDatasetSchema.safeParse(dataset).success).toBe(false);
  });

  it('accepts a well-formed reviewed dataset', () => {
    const dataset = {
      taxonomyVersion: 1,
      reviewedBy: 'reviewer',
      reviewedAt: '2026-09-04',
      items: [{ ...makeGold(), note: 'Dim lighting; body type is a judgement call.' }],
    };
    expect(goldDatasetSchema.safeParse(dataset).success).toBe(true);
  });
});
