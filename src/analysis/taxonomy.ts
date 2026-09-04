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
 * Every categorical field describes APPARENT presentation as visible in the
 * sampled frames. None of it is a claim about anyone's real identity, and the
 * taxonomy deliberately carries no ethnicity/race axis: it is unreliable from a
 * handful of frames and optimising a recommender on inferred race is a liability
 * with no upside. See ARCHITECTURE.md "Tradeoffs".
 */

/**
 * Bump whenever TAXONOMY_LAYOUT changes in any way (added value, removed value,
 * reordered). Stored on every embedding row so vectors from different spaces are
 * detectable rather than silently mixed.
 *
 * A taxonomy version bump that changes TAXONOMY_DIM is NOT a code-only change.
 * The vector dimension is baked into the PostgreSQL column type: a `vector(109)`
 * column physically cannot store a 110-dimensional vector, and pgvector rejects
 * distance operations between vectors of different dimensions. Changing the
 * taxonomy therefore requires, in order:
 *
 *   1. schema migration      vector(N) -> vector(M)
 *   2. re-encode every video vector      (video_embeddings)
 *   3. re-encode every user profile      (user_profiles)
 *   4. rebuild the HNSW index
 *
 * Steps 2 and 3 must both happen: a profile is a sum of video vectors, so a
 * half-migrated system has profiles in the old space scoring videos in the new
 * one. Because raw model output is retained in video_features.raw, re-encoding is
 * a local recompute and does not require re-running the VLM - but a v1 -> v2
 * rename (e.g. performerGenders -> performerGender) is a semantic change the old
 * raw output cannot satisfy, so those rows need re-analysis.
 *
 * The full procedure is in ARCHITECTURE.md "Taxonomy versioning and re-embedding".
 *
 * v2 (current): restructured before the corpus was populated - most multi-value
 * fields collapsed to single dominant-value fields, `mood` and `cameraFraming`
 * dropped, body/anatomy/age/media-type axes added. Frozen until the first
 * benchmark against a real VLM.
 */
export const TAXONOMY_VERSION = 2;

export type FieldKind = 'single' | 'multi';

export interface TaxonomyField {
  readonly kind: FieldKind;
  readonly values: readonly string[];
  /** Relative pull this field has on content similarity. Applied when encoding. */
  readonly weight: number;
  readonly description: string;
}

/**
 * Values meaning "could not be determined" rather than a real observation.
 *
 * These occupy a layout slot (so the mapping stays complete and stable) but are
 * encoded as zero: two videos whose hair colour is both undeterminable share no
 * content, and letting `unknown` match `unknown` would manufacture similarity out
 * of missing information. `none` and `other` are NOT in this set - "no sex
 * position" and "a setting outside the list" are genuine observations.
 */
export const UNINFORMATIVE_VALUES: ReadonlySet<string> = new Set(['unknown']);

export const TAXONOMY = {
  // ----------------------------------------------------------------- single
  performerCount: {
    kind: 'single',
    weight: 0.6,
    values: ['none', 'solo', 'duo', 'group'],
    description: 'How many people are visible for most of the video',
  },
  performerGender: {
    kind: 'single',
    weight: 1.0,
    values: ['female', 'male', 'mixed', 'unknown'],
    description:
      'Apparent gender presentation/composition of the people shown; not a claim about real identity',
  },
  adultAgeGroup: {
    kind: 'single',
    weight: 0.6,
    values: ['18_24', '25_34', '35_44', '45_plus', 'unknown'],
    description:
      'Approximate apparent adult age group of the main performer; all participants are already known to be 18+. Use unknown when in doubt',
  },
  hairColor: {
    kind: 'single',
    weight: 0.8,
    values: ['blonde', 'dark', 'red', 'colored', 'other', 'unknown'],
    description:
      'Hair colour of the main performer; dark covers brunette and black, colored means visibly dyed unnatural colours',
  },
  bodyType: {
    kind: 'single',
    weight: 0.6,
    values: ['slim', 'athletic', 'curvy', 'plus_size', 'average', 'unknown'],
    description: 'Apparent build of the main performer',
  },
  breastSize: {
    kind: 'single',
    weight: 0.5,
    values: ['small', 'medium', 'large', 'unknown'],
    description: 'Apparent breast size of the main performer',
  },
  buttSize: {
    kind: 'single',
    weight: 0.5,
    values: ['small', 'medium', 'large', 'unknown'],
    description: 'Apparent butt size of the main performer',
  },
  penisSize: {
    kind: 'single',
    weight: 0.5,
    values: ['small', 'medium', 'large', 'unknown'],
    description: 'Apparent penis size of the main performer, if visible',
  },
  mediaType: {
    kind: 'single',
    weight: 0.8,
    values: ['live_action', 'animated', 'other'],
    description: 'Whether the video is filmed or animated',
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
    description: 'Dominant location the video takes place in',
  },
  clothing: {
    kind: 'single',
    weight: 0.7,
    values: [
      'lingerie',
      'swimwear',
      'casual',
      'costume',
      'uniform',
      'partially_nude',
      'nude',
      'other',
      'unknown',
    ],
    description: 'Dominant clothing state of the main performer',
  },
  sexPosition: {
    kind: 'single',
    weight: 1.0,
    values: [
      'none',
      'riding',
      'reverse_riding',
      'missionary',
      'doggy',
      'standing',
      'side',
      'other',
      'mixed',
      'unknown',
    ],
    description:
      'Dominant sex position; mixed when several occupy a significant part of the video with no dominant one, none when there is no sex position',
  },
  penetrationType: {
    kind: 'single',
    weight: 1.1,
    values: ['none', 'vaginal', 'anal', 'double_penetration', 'mixed', 'other', 'unknown'],
    description:
      'Type of penetration shown; double_penetration means simultaneous, mixed means different types at different moments',
  },
  cameraStyle: {
    kind: 'single',
    weight: 0.4,
    values: ['standard', 'pov', 'selfie', 'mixed'],
    description: 'How the video is shot',
  },
  explicitness: {
    kind: 'single',
    weight: 0.9,
    values: ['sfw', 'suggestive', 'nudity', 'explicit'],
    description:
      'sfw = ordinary safe content; suggestive = sexualised without explicit nudity or sex act; nudity = nudity without an explicit sex act; explicit = explicit sex act',
  },
  productionQuality: {
    kind: 'single',
    weight: 0.3,
    values: ['amateur', 'semi_pro', 'professional', 'unknown'],
    description: 'Apparent production value',
  },

  // ------------------------------------------------------------------ multi
  appearanceFeatures: {
    kind: 'multi',
    weight: 0.5,
    values: ['tattoos', 'piercings'],
    description: 'Visible body modifications; empty array if none',
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
      'manual',
      'toy_use',
      'massage',
      'talking',
      'penetrative_sex',
    ],
    description:
      'What is happening in the video; the specific penetration type belongs in penetrationType, not here',
  },
  fetishTags: {
    kind: 'multi',
    weight: 1.0,
    values: [
      'feet',
      'bdsm',
      'latex_leather',
      'stockings',
      'roleplay',
      'cosplay',
      'voyeur',
      'public',
    ],
    description: 'Recognisable fetish or niche themes; empty array if none',
  },
} as const satisfies Record<string, TaxonomyField>;

export type Taxonomy = typeof TAXONOMY;
export type TaxonomyKey = keyof Taxonomy;

export const TAXONOMY_KEYS = Object.keys(TAXONOMY) as TaxonomyKey[];

export type ValueOf<K extends TaxonomyKey> = Taxonomy[K]['values'][number];

/**
 * FROZEN tag -> dimension mapping for TAXONOMY_VERSION 2.
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
 *
 * The one exception was v2 itself, assembled here in grouped order while the corpus
 * was still empty and no vector had ever been persisted. From this point the array
 * is append-only: `productionQuality:unknown` sits inside its field's block, which
 * would have been illegal against live data because it shifts every dimension after
 * it.
 */
export const TAXONOMY_LAYOUT = [
  'performerCount:none',
  'performerCount:solo',
  'performerCount:duo',
  'performerCount:group',

  'performerGender:female',
  'performerGender:male',
  'performerGender:mixed',
  'performerGender:unknown',

  'adultAgeGroup:18_24',
  'adultAgeGroup:25_34',
  'adultAgeGroup:35_44',
  'adultAgeGroup:45_plus',
  'adultAgeGroup:unknown',

  'hairColor:blonde',
  'hairColor:dark',
  'hairColor:red',
  'hairColor:colored',
  'hairColor:other',
  'hairColor:unknown',

  'bodyType:slim',
  'bodyType:athletic',
  'bodyType:curvy',
  'bodyType:plus_size',
  'bodyType:average',
  'bodyType:unknown',

  'breastSize:small',
  'breastSize:medium',
  'breastSize:large',
  'breastSize:unknown',

  'buttSize:small',
  'buttSize:medium',
  'buttSize:large',
  'buttSize:unknown',

  'penisSize:small',
  'penisSize:medium',
  'penisSize:large',
  'penisSize:unknown',

  'mediaType:live_action',
  'mediaType:animated',
  'mediaType:other',

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
  'clothing:other',
  'clothing:unknown',

  'sexPosition:none',
  'sexPosition:riding',
  'sexPosition:reverse_riding',
  'sexPosition:missionary',
  'sexPosition:doggy',
  'sexPosition:standing',
  'sexPosition:side',
  'sexPosition:other',
  'sexPosition:mixed',
  'sexPosition:unknown',

  'penetrationType:none',
  'penetrationType:vaginal',
  'penetrationType:anal',
  'penetrationType:double_penetration',
  'penetrationType:mixed',
  'penetrationType:other',
  'penetrationType:unknown',

  'cameraStyle:standard',
  'cameraStyle:pov',
  'cameraStyle:selfie',
  'cameraStyle:mixed',

  'explicitness:sfw',
  'explicitness:suggestive',
  'explicitness:nudity',
  'explicitness:explicit',

  'productionQuality:amateur',
  'productionQuality:semi_pro',
  'productionQuality:professional',
  'productionQuality:unknown',

  'appearanceFeatures:tattoos',
  'appearanceFeatures:piercings',

  'actType:posing',
  'actType:dancing',
  'actType:undressing',
  'actType:solo_touching',
  'actType:kissing',
  'actType:oral',
  'actType:manual',
  'actType:toy_use',
  'actType:massage',
  'actType:talking',
  'actType:penetrative_sex',

  'fetishTags:feet',
  'fetishTags:bdsm',
  'fetishTags:latex_leather',
  'fetishTags:stockings',
  'fetishTags:roleplay',
  'fetishTags:cosplay',
  'fetishTags:voyeur',
  'fetishTags:public',
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

  if (slotIndexByTag.size !== TAXONOMY_LAYOUT.length) {
    throw new Error(`TAXONOMY_LAYOUT contains duplicate entries (taxonomy v${TAXONOMY_VERSION}).`);
  }
}

assertLayoutMatchesTaxonomy();

export function slotIndex(key: TaxonomyKey, value: string): number | undefined {
  return slotIndexByTag.get(`${key}:${value}`);
}

export function fieldWeight(key: TaxonomyKey): number {
  return TAXONOMY[key].weight;
}

/** True for values that mean "could not be determined" - encoded as zero. */
export function isUninformative(value: string): boolean {
  return UNINFORMATIVE_VALUES.has(value);
}

/** Human-readable name for a dimension - powers "why this video?" in the demo. */
export function describeSlot(index: number): string {
  return TAXONOMY_LAYOUT[index] ?? `dim_${index}`;
}
