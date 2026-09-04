import type { VideoFeatures } from '../src/analysis/schema.ts';

/** A valid, fully-populated feature set (taxonomy v2). Override fields per test. */
export function makeFeatures(overrides: Partial<VideoFeatures> = {}): VideoFeatures {
  return {
    performerCount: 'solo',
    performerGender: 'female',
    adultAgeGroup: '25_34',
    hairColor: 'blonde',
    bodyType: 'slim',
    breastSize: 'medium',
    buttSize: 'medium',
    penisSize: 'unknown',
    mediaType: 'live_action',
    setting: 'bedroom',
    clothing: 'lingerie',
    sexPosition: 'none',
    penetrationType: 'none',
    cameraStyle: 'standard',
    explicitness: 'suggestive',
    productionQuality: 'amateur',

    appearanceFeatures: ['tattoos'],
    actType: ['posing'],
    fetishTags: ['stockings'],

    aestheticScore: 0.7,
    caption: 'A woman poses in lingerie in a bedroom.',
    confidence: {},
    ...overrides,
  };
}
