import { TAXONOMY, type TaxonomyKey, isUninformative } from '../analysis/taxonomy.ts';
import type { VideoFeatures } from '../analysis/schema.ts';

/**
 * Which taxonomy values count as "the same kind of thing" for diversity and fatigue.
 *
 * Not every dimension is equally useful here. On an adult corpus almost every video
 * is `performerGender:female`, `explicitness:explicit` and `mediaType:live_action`;
 * treating those as diversity tags would let a cap of 3 in the top 10 block the
 * entire feed while telling the user nothing about variety. The fields below are
 * the ones where two videos differing genuinely feel different.
 *
 * One policy, one place: both the diversity re-ranker and the fatigue feature call
 * this, so "similar content" cannot come to mean two different things in two files.
 * It works through taxonomy semantics - never through vector offsets.
 */
export const DIVERSITY_TAG_FIELDS: readonly TaxonomyKey[] = [
  'actType',
  'fetishTags',
  'setting',
  'cameraStyle',
  'hairColor',
  'sexPosition',
  'penetrationType',
];

/**
 * Deliberately excluded, and why:
 *
 * - `performerGender`, `explicitness`, `mediaType` - near-constant on this corpus.
 * - `productionQuality` - a content property, not a kind of content.
 * - `adultAgeGroup`, body/appearance measurements - low measured accuracy (0.00
 *   informative for adultAgeGroup on every model tested), so capping on them would
 *   enforce variety along an axis the analyser cannot actually read.
 */
export const EXCLUDED_FROM_DIVERSITY: readonly TaxonomyKey[] = [
  'performerCount',
  'performerGender',
  'adultAgeGroup',
  'bodyType',
  'breastSize',
  'buttSize',
  'penisSize',
  'mediaType',
  'clothing',
  'explicitness',
  'productionQuality',
  'appearanceFeatures',
];

/**
 * `none` means "this does not apply" and `unknown` means "could not tell". Neither
 * describes content, so neither is a reason to call two videos similar - otherwise
 * every non-penetrative video would collide on `penetrationType:none`.
 */
function isMeaningfulValue(value: string): boolean {
  return !isUninformative(value) && value !== 'none';
}

/** The meaningful diversity tags of one video, as `field:value` strings. */
export function diversityTags(features: VideoFeatures): string[] {
  const tags: string[] = [];

  for (const field of DIVERSITY_TAG_FIELDS) {
    const raw = features[field];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of new Set(values)) {
      if (typeof value === 'string' && isMeaningfulValue(value)) {
        tags.push(`${field}:${value}`);
      }
    }
  }

  return tags;
}

/** Guards the field lists against a taxonomy change that adds or renames a field. */
export function assertDiversityPolicyCoversTaxonomy(): void {
  const covered = new Set<string>([...DIVERSITY_TAG_FIELDS, ...EXCLUDED_FROM_DIVERSITY]);
  const missing = (Object.keys(TAXONOMY) as TaxonomyKey[]).filter((key) => !covered.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Diversity tag policy does not classify: ${missing.join(', ')}. ` +
        `Add each field to DIVERSITY_TAG_FIELDS or EXCLUDED_FROM_DIVERSITY.`,
    );
  }
}

assertDiversityPolicyCoversTaxonomy();
