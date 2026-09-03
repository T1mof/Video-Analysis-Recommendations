import type { VideoFeatures } from '../src/analysis/schema.ts';

/** A valid, fully-populated feature set. Override fields per test. */
export function makeFeatures(overrides: Partial<VideoFeatures> = {}): VideoFeatures {
  return {
    performerCount: 'solo',
    performerGenders: ['female'],
    hairColor: ['blonde'],
    bodyType: ['slim'],
    setting: 'bedroom',
    clothing: ['lingerie'],
    actType: ['posing'],
    penetrationType: 'none',
    fetishTags: ['stockings'],
    cameraFraming: 'medium',
    explicitness: 'suggestive',
    productionQuality: 'amateur',
    mood: 'playful',
    aestheticScore: 0.7,
    caption: 'A woman poses in lingerie in a bedroom.',
    confidence: {},
    ...overrides,
  };
}
