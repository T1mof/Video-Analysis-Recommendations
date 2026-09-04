/**
 * Closed content taxonomy and the frozen tag -> dimension mapping.
 *
 * The VLM is never allowed to invent tags: it must answer with values drawn from
 * these lists (enforced by Zod in ./schema.ts). Three reasons this matters:
 *
 *  1. A fixed vocabulary is a fixed vector layout, so video and user-profile
 *     embeddings live in the same interpretable space (see ./embedding.ts).
 *  2. Free-text tags drift between model versions and make features from two
 *     models incomparable - which would break scripts/bench-vlm.ts.
 *  3. Recommendations become explainable: every dimension has a name.
 *
 * The embedding carries taxonomy features only. Continuous signals - aesthetic
 * score, duration, popularity, freshness, creator affinity - are applied at the
 * ranking stage instead (see ../recommend/rank.ts). They could be embedded here
 * with appropriate normalisation; they are kept separate because they answer a
 * different question ("is this item good/fresh?" rather than "is this content
 * similar?") and because separating them lets those weights be re-tuned without
 * re-encoding vectors or rebuilding the HNSW index.
 *
 * Deliberately NOT included: ethnicity/race inference. It is unreliable from a
 * handful of frames, and building a recommender that optimises on inferred race is
 * a liability with no upside here - other axes carry the personalisation signal.
 * See ARCHITECTURE.md "Tradeoffs".
 */

/**
 * Bump whenever TAXONOMY_LAYOUT changes in any way (added value, removed value,
 * reordered). Stored on every embedding row so vectors from different spaces are
 * detectable rather than silently mixed.
 *
 * A taxonomy version bump that changes TAXONOMY_DIM is NOT a code-only change.
 * The vector dimension is baked into the PostgreSQL column type: a `vector(83)`
 * column physically cannot store an 84-dimensional vector, and pgvector rejects
 * distance operations between vectors of different dimensions. Adding one tag
 * therefore requires, in order:
 *
 *   1. schema migration      vector(83) -> vector(84)
 *   2. re-encode every video vector      (video_embeddings)
 *   3. re-encode every user profile      (user_profiles)
 *   4. rebuild the HNSW index
 *
 * Steps 2 and 3 must both happen: a profile is a sum of video vectors, so a
 * half-migrated system has profiles in the old space scoring videos in the new
 * one. Because raw model output is retained in video_features.raw, re-encoding is
 * a local recompute and does not require re-running the VLM.
 *
 * The full procedure, including how to do it without downtime at scale, is in
 * ARCHITECTURE.md "Taxonomy versioning and re-embedding".
 */
export const TAXONOMY_VERSION = 1;

export type FieldKind = 'single' | 'multi';

export interface TaxonomyField {
  readonly kind: FieldKind;
  readonly values: readonly string[];
  /** Relative pull this field has on content similarity. Applied when encoding. */
  readonly weight: number;
  readonly description: string;
}

export const TAXONOMY = {
  performerCount: {
    kind: 'single',
    weight: 0.8,
    values: ['none', 'solo', 'duo', 'group'],
    description: 'How many people are visible for most of the video',
  },
  performerGenders: {
    kind: 'multi',
    weight: 1.0,
    values: ['female', 'male', 'trans', 'unknown'],
    description: 'Apparent gender presentation of the people shown',
  },
  hairColor: {
    kind: 'multi',
    weight: 0.9,
    values: ['blonde', 'brunette', 'black', 'red', 'colored', 'other'],
    description: 'Hair colour of the main performer(s)',
  },
  bodyType: {
    kind: 'multi',
    weight: 0.7,
    values: ['slim', 'athletic', 'curvy', 'plus_size', 'average'],
    description: 'Apparent build of the main performer(s)',
  },
  setting: {
    kind: 'single',
    weight: 0.6,
    values: [
      'bedroom',
      'bathroom',
      'living_room',
      'kitchen',
      'outdoor',
      'pool',
      'studio',
      'car',
      'gym',
      'office',
      'other',
    ],
    description: 'Where the video takes place',
  },
  clothing: {
    kind: 'multi',
    weight: 0.9,
    values: ['lingerie', 'swimwear', 'casual', 'costume', 'uniform', 'partially_nude', 'nude'],
    description: 'What the performer(s) are wearing',
  },
  actType: {
    kind: 'multi',
    weight: 1.2,
    values: [
      'posing',
      'dancing',
      'undressing',
      'solo_touching',
      'kissing',
      'oral',
      'vaginal',
      'anal',
      'manual',
      'massage',
      'talking',
    ],
    description: 'What is happening in the video',
  },
  penetrationType: {
    kind: 'single',
    weight: 1.1,
    values: ['none', 'vaginal', 'anal', 'oral', 'multiple'],
    description: 'Type of penetration shown, if any',
  },
  fetishTags: {
    kind: 'multi',
    weight: 1.0,
    values: [
      'none',
      'feet',
      'bdsm',
      'latex_leather',
      'stockings',
      'roleplay',
      'cosplay',
      'tattoos',
      'piercings',
      'voyeur',
      'public',
    ],
    description: 'Recognisable fetish or niche themes',
  },
  cameraFraming: {
    kind: 'single',
    weight: 0.5,
    values: ['close_up', 'medium', 'wide', 'pov', 'selfie', 'mixed'],
    description: 'Dominant camera framing',
  },
  explicitness: {
    kind: 'single',
    weight: 1.0,
    values: ['sfw', 'suggestive', 'topless', 'softcore', 'hardcore'],
    description: 'How explicit the content is overall',
  },
  productionQuality: {
    kind: 'single',
    weight: 0.4,
    values: ['amateur', 'semi_pro', 'professional'],
    description: 'Apparent production value',
  },
  mood: {
    kind: 'single',
    weight: 0.5,
    values: ['playful', 'sensual', 'intense', 'romantic', 'neutral'],
    description: 'Overall tone',
  },
} as const satisfies Record<string, TaxonomyField>;

export type Taxonomy = typeof TAXONOMY;
export type TaxonomyKey = keyof Taxonomy;

export const TAXONOMY_KEYS = Object.keys(TAXONOMY) as TaxonomyKey[];

export type ValueOf<K extends TaxonomyKey> = Taxonomy[K]['values'][number];

/**
 * FROZEN tag -> dimension mapping for TAXONOMY_VERSION 1.
 *
 * Written out explicitly rather than derived from object key order, because
 * object order is an accident of declaration: reordering a field above would
 * silently shift every dimension after it and quietly invalidate every stored
 * embedding. Index in this array IS the vector dimension, permanently.
 *
 * To change the taxonomy: append new entries at the END and bump TAXONOMY_VERSION.
 * Never insert or reorder. Appending keeps existing dimensions stable but still
 * changes TAXONOMY_DIM, which requires the full migration + re-embedding procedure
 * documented on TAXONOMY_VERSION above - it is not a code-only change.
 */
export const TAXONOMY_LAYOUT = [
  'performerCount:none',
  'performerCount:solo',
  'performerCount:duo',
  'performerCount:group',

  'performerGenders:female',
  'performerGenders:male',
  'performerGenders:trans',
  'performerGenders:unknown',

  'hairColor:blonde',
  'hairColor:brunette',
  'hairColor:black',
  'hairColor:red',
  'hairColor:colored',
  'hairColor:other',

  'bodyType:slim',
  'bodyType:athletic',
  'bodyType:curvy',
  'bodyType:plus_size',
  'bodyType:average',

  'setting:bedroom',
  'setting:bathroom',
  'setting:living_room',
  'setting:kitchen',
  'setting:outdoor',
  'setting:pool',
  'setting:studio',
  'setting:car',
  'setting:gym',
  'setting:office',
  'setting:other',

  'clothing:lingerie',
  'clothing:swimwear',
  'clothing:casual',
  'clothing:costume',
  'clothing:uniform',
  'clothing:partially_nude',
  'clothing:nude',

  'actType:posing',
  'actType:dancing',
  'actType:undressing',
  'actType:solo_touching',
  'actType:kissing',
  'actType:oral',
  'actType:vaginal',
  'actType:anal',
  'actType:manual',
  'actType:massage',
  'actType:talking',

  'penetrationType:none',
  'penetrationType:vaginal',
  'penetrationType:anal',
  'penetrationType:oral',
  'penetrationType:multiple',

  'fetishTags:none',
  'fetishTags:feet',
  'fetishTags:bdsm',
  'fetishTags:latex_leather',
  'fetishTags:stockings',
  'fetishTags:roleplay',
  'fetishTags:cosplay',
  'fetishTags:tattoos',
  'fetishTags:piercings',
  'fetishTags:voyeur',
  'fetishTags:public',

  'cameraFraming:close_up',
  'cameraFraming:medium',
  'cameraFraming:wide',
  'cameraFraming:pov',
  'cameraFraming:selfie',
  'cameraFraming:mixed',

  'explicitness:sfw',
  'explicitness:suggestive',
  'explicitness:topless',
  'explicitness:softcore',
  'explicitness:hardcore',

  'productionQuality:amateur',
  'productionQuality:semi_pro',
  'productionQuality:professional',

  'mood:playful',
  'mood:sensual',
  'mood:intense',
  'mood:romantic',
  'mood:neutral',
] as const;

/** Vector dimension. Categorical slots only - no continuous features. */
export const TAXONOMY_DIM = TAXONOMY_LAYOUT.length;

const slotIndexByTag = new Map<string, number>(
  TAXONOMY_LAYOUT.map((tag, index) => [tag, index]),
);

/**
 * Fail fast at import time if TAXONOMY and TAXONOMY_LAYOUT disagree - i.e. someone
 * added a taxonomy value but forgot to append it to the frozen layout. A silent
 * mismatch here would mean tags that never reach the vector at all.
 */
function assertLayoutMatchesTaxonomy(): void {
  const fromTaxonomy = new Set<string>();
  for (const key of TAXONOMY_KEYS) {
    for (const value of TAXONOMY[key].values) fromTaxonomy.add(`${key}:${value}`);
  }

  const missing = [...fromTaxonomy].filter((tag) => !slotIndexByTag.has(tag));
  const orphaned = TAXONOMY_LAYOUT.filter((tag) => !fromTaxonomy.has(tag));

  if (missing.length > 0 || orphaned.length > 0) {
    throw new Error(
      `TAXONOMY_LAYOUT is out of sync with TAXONOMY (taxonomy v${TAXONOMY_VERSION}).\n` +
        (missing.length ? `  Missing from layout: ${missing.join(', ')}\n` : '') +
        (orphaned.length ? `  In layout but not in taxonomy: ${orphaned.join(', ')}\n` : '') +
        `  Append new tags to the END of TAXONOMY_LAYOUT and bump TAXONOMY_VERSION.`,
    );
  }
}

assertLayoutMatchesTaxonomy();

export function slotIndex(key: TaxonomyKey, value: string): number | undefined {
  return slotIndexByTag.get(`${key}:${value}`);
}

export function fieldWeight(key: TaxonomyKey): number {
  return TAXONOMY[key].weight;
}

/** Human-readable name for a dimension - powers "why this video?" in the demo. */
export function describeSlot(index: number): string {
  return TAXONOMY_LAYOUT[index] ?? `dim_${index}`;
}
