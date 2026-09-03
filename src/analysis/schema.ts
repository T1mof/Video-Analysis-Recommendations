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
 */

const single = <K extends TaxonomyKey>(key: K) => z.enum(TAXONOMY[key].values);
const multi = <K extends TaxonomyKey>(key: K) =>
  z.array(z.enum(TAXONOMY[key].values)).max(TAXONOMY[key].values.length);

export const videoFeaturesSchema = z.object({
  performerCount: single('performerCount'),
  performerGenders: multi('performerGenders'),
  hairColor: multi('hairColor'),
  bodyType: multi('bodyType'),
  setting: single('setting'),
  clothing: multi('clothing'),
  actType: multi('actType'),
  penetrationType: single('penetrationType'),
  fetishTags: multi('fetishTags'),
  cameraFraming: single('cameraFraming'),
  explicitness: single('explicitness'),
  productionQuality: single('productionQuality'),
  mood: single('mood'),

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
  const fields = TAXONOMY_KEYS.map((key) => {
    const field = TAXONOMY[key];
    const cardinality = field.kind === 'single' ? 'exactly one' : 'zero or more';
    return `- ${key} (${cardinality}): ${field.description}. Allowed: ${field.values.join(', ')}`;
  }).join('\n');

  return [
    `You are tagging an adult vertical short-form video for a content recommendation system.`,
    `You are shown ${frameCount} frames sampled across its ${durationSeconds.toFixed(1)} seconds, in chronological order.`,
    ``,
    `Describe the video as a whole, not any single frame. Judge what is true for most of the video.`,
    ``,
    `Fields:`,
    fields,
    `- aestheticScore: number 0..1, overall visual appeal.`,
    `- caption: one short sentence describing the video.`,
    `- confidence: object mapping the field names above to your confidence, 0..1.`,
    ``,
    `Rules:`,
    `- Use ONLY the allowed values listed. Never invent a value.`,
    `- For multi-value fields, return only values you actually observe; an empty array is valid.`,
    `- All people depicted are consenting adults; do not comment on age beyond that.`,
    `- Respond with a single JSON object and nothing else.`,
    `(taxonomy v${TAXONOMY_VERSION})`,
  ].join('\n');
}
