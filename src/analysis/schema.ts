import { z } from 'zod';
import { TAXONOMY, TAXONOMY_KEYS, TAXONOMY_VERSION, type TaxonomyKey } from './taxonomy.ts';

/**
 * Runtime contract for VLM output.
 *
 * Every categorical field is pinned to the closed taxonomy, so a model that
 * hallucinates "platinum_blonde" fails validation instead of silently poisoning
 * the vector space. Validation failures are retried once with the error text fed
 * back to the model (see vision/openaiCompatible.ts) before the video is marked
 * failed - that repair loop is cheaper than a bad row.
 *
 * Cardinality mirrors the taxonomy exactly: 16 single-value fields and 3
 * multi-value ones (appearanceFeatures, actType, fetishTags). An absent
 * multi-value observation is an empty array, never a `none` sentinel - `none` only
 * exists where it is a real observation (performerCount, sexPosition,
 * penetrationType).
 */

const single = <K extends TaxonomyKey>(key: K) => z.enum(TAXONOMY[key].values);
const multi = <K extends TaxonomyKey>(key: K) =>
  z.array(z.enum(TAXONOMY[key].values)).max(TAXONOMY[key].values.length);

export const videoFeaturesSchema = z.object({
  // --- single -------------------------------------------------------------
  performerCount: single('performerCount'),
  performerGender: single('performerGender'),
  adultAgeGroup: single('adultAgeGroup'),
  hairColor: single('hairColor'),
  bodyType: single('bodyType'),
  breastSize: single('breastSize'),
  buttSize: single('buttSize'),
  penisSize: single('penisSize'),
  mediaType: single('mediaType'),
  setting: single('setting'),
  clothing: single('clothing'),
  sexPosition: single('sexPosition'),
  penetrationType: single('penetrationType'),
  cameraStyle: single('cameraStyle'),
  explicitness: single('explicitness'),
  productionQuality: single('productionQuality'),

  // --- multi --------------------------------------------------------------
  appearanceFeatures: multi('appearanceFeatures'),
  actType: multi('actType'),
  fetishTags: multi('fetishTags'),

  /** Subjective visual appeal, 0..1. Used as a mild quality prior in ranking. */
  aestheticScore: z.number().min(0).max(1),
  /** One sentence, for debugging and for the demo panel. Never used as a tag. */
  caption: z.string().min(1).max(300),
  /** Per-field self-reported confidence, 0..1. Missing keys are treated as 0.5. */
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
});

export type VideoFeatures = z.infer<typeof videoFeaturesSchema>;

export function confidenceFor(features: VideoFeatures, key: TaxonomyKey): number {
  return features.confidence[key] ?? 0.5;
}

/**
 * JSON Schema mirroring the Zod shape, for providers that support constrained
 * decoding (`response_format: json_schema`). Generated from the taxonomy so the
 * two can never drift apart.
 */
export function jsonSchemaForFeatures(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const key of TAXONOMY_KEYS) {
    const field = TAXONOMY[key];
    const values = [...field.values];
    properties[key] =
      field.kind === 'single'
        ? { type: 'string', enum: values, description: field.description }
        : {
            type: 'array',
            items: { type: 'string', enum: values },
            uniqueItems: true,
            description: field.description,
          };
  }

  properties.aestheticScore = {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'Overall visual appeal, 0 = poor, 1 = excellent',
  };
  properties.caption = {
    type: 'string',
    description: 'One short sentence describing the video',
  };
  properties.confidence = {
    type: 'object',
    additionalProperties: { type: 'number', minimum: 0, maximum: 1 },
    description: 'Confidence per field name, 0..1',
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: [...TAXONOMY_KEYS, 'aestheticScore', 'caption', 'confidence'],
    properties,
  };
}

/** The instruction sent alongside the sampled frames. */
export function buildPrompt(frameCount: number, durationSeconds: number): string {
  const singleFields = TAXONOMY_KEYS.filter((key) => TAXONOMY[key].kind === 'single');
  const multiFields = TAXONOMY_KEYS.filter((key) => TAXONOMY[key].kind === 'multi');

  const describe = (key: TaxonomyKey): string =>
    `- ${key}: ${TAXONOMY[key].description}.\n  Allowed: ${TAXONOMY[key].values.join(', ')}`;

  return [
    `You are tagging an adult vertical short-form video for a content recommendation system.`,
    `You are shown ${frameCount} frames sampled across its ${durationSeconds.toFixed(1)} seconds, in chronological order.`,
    ``,
    `Describe the video as a whole, not any single frame. Judge what is true for most of the video.`,
    ``,
    `SINGLE-VALUE fields - return exactly one allowed value as a string:`,
    singleFields.map(describe).join('\n'),
    ``,
    `MULTI-VALUE fields - return an array of allowed values, or [] if none apply:`,
    multiFields.map(describe).join('\n'),
    ``,
    `Also return:`,
    `- aestheticScore: number 0..1, overall visual appeal.`,
    `- caption: one short sentence describing the video.`,
    `- confidence: object mapping the field names above to your confidence, 0..1.`,
    ``,
    `Rules:`,
    `- Use ONLY the allowed values listed. Never invent a value.`,
    `- Every field above must be present in the response.`,
    `- Describe apparent presentation as visible in the frames. This is never a claim about anyone's real identity.`,
    `- Where several people appear, describe the main/dominant performer for adultAgeGroup, hairColor, bodyType, breastSize, buttSize and penisSize.`,
    `- Use "unknown" when you genuinely cannot tell. Do not guess.`,
    `- All participants are already known to be consenting adults; adultAgeGroup is an approximate apparent adult age band only.`,
    `- For multi-value fields return only values you actually observe; [] is valid and expected when nothing applies.`,
    `- Do not repeat a value within a multi-value field.`,
    `- Respond with a single JSON object and nothing else.`,
    `(taxonomy v${TAXONOMY_VERSION})`,
  ].join('\n');
}
