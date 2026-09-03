/**
 * Closed content taxonomy.
 *
 * The VLM is never allowed to invent tags: it must answer with values drawn from
 * these lists (enforced by Zod in ./schema.ts). Three reasons this matters:
 *
 *  1. A fixed vocabulary is a fixed vector layout, so video and user-profile
 *     embeddings live in the same interpretable space (see ./embedding.ts).
 *  2. Free-text tags drift between model versions and make features from two
 *     models incomparable - which would break the benchmark in scripts/bench-vlm.ts.
 *  3. Recommendations become explainable: every dimension has a name.
 *
 * Deliberately NOT included: ethnicity/race inference. It is unreliable from a
 * handful of frames, and building a recommender that optimises on inferred race is
 * a liability with no upside here - other axes carry the personalisation signal.
 * See ARCHITECTURE.md "Tradeoffs".
 *
 * Changing any list changes TAXONOMY_DIM and invalidates stored embeddings; bump
 * TAXONOMY_VERSION and re-encode. Analysis rows record the version they were
 * written with.
 */

export const TAXONOMY_VERSION = 1;

export type FieldKind = 'single' | 'multi';

export interface TaxonomyField {
  readonly kind: FieldKind;
  readonly values: readonly string[];
  /** Relative pull this field has on similarity. Applied when encoding vectors. */
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
    values: [
      'lingerie',
      'swimwear',
      'casual',
      'costume',
      'uniform',
      'partially_nude',
      'nude',
    ],
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

/** Values a single field may take. */
export type ValueOf<K extends TaxonomyKey> = Taxonomy[K]['values'][number];

/**
 * Fixed vector slot layout: one dimension per (field, value) pair, in a stable
 * order derived from the declaration order above. Two extra tail slots carry
 * continuous signals that are not categorical.
 */
export interface SlotRef {
  readonly key: TaxonomyKey;
  readonly value: string;
  readonly index: number;
  readonly weight: number;
}

function buildLayout(): { slots: SlotRef[]; index: Map<string, number> } {
  const slots: SlotRef[] = [];
  const index = new Map<string, number>();
  for (const key of TAXONOMY_KEYS) {
    const field = TAXONOMY[key];
    for (const value of field.values) {
      const slot: SlotRef = { key, value, index: slots.length, weight: field.weight };
      index.set(`${key}:${value}`, slot.index);
      slots.push(slot);
    }
  }
  return { slots, index };
}

const layout = buildLayout();

export const TAXONOMY_SLOTS: readonly SlotRef[] = layout.slots;

/** Number of categorical slots, before the continuous tail. */
export const CATEGORICAL_DIM = layout.slots.length;

/**
 * Continuous tail dimensions, appended after the categorical slots:
 *   [0] aesthetic score (0..1)
 *   [1] normalised duration (0..1, saturating at 180s)
 */
export const TAIL_DIM = 2;

export const TAXONOMY_DIM = CATEGORICAL_DIM + TAIL_DIM;

export function slotIndex(key: TaxonomyKey, value: string): number | undefined {
  return layout.index.get(`${key}:${value}`);
}

/** Human-readable name for a vector dimension - powers "why this video?" in the demo. */
export function describeSlot(index: number): string {
  if (index < CATEGORICAL_DIM) {
    const slot = TAXONOMY_SLOTS[index]!;
    return `${slot.key}=${slot.value}`;
  }
  return index === CATEGORICAL_DIM ? 'aestheticScore' : 'durationNorm';
}
