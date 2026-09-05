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

/**
 * Bump whenever buildPrompt() changes in a way that could alter model output.
 * Stored per row so features produced by different prompts stay comparable - a
 * benchmark that mixes prompt versions measures the prompt, not the model.
 */
export const PROMPT_VERSION = 2;

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

/**
 * The instruction sent alongside the sampled frames.
 *
 * Built from the taxonomy so the allowed vocabulary can never drift from what Zod
 * enforces. The disambiguation rules exist because the fields most likely to be
 * confused are also the ones that matter most for recommendation - conflating
 * `penetrationType` with oral acts, or `none` with `unknown`, produces features
 * that are individually plausible and collectively useless.
 */
export function buildPrompt(frameCount: number, durationSeconds: number): string {
  const singleFields = TAXONOMY_KEYS.filter((key) => TAXONOMY[key].kind === 'single');
  const multiFields = TAXONOMY_KEYS.filter((key) => TAXONOMY[key].kind === 'multi');

  const describe = (key: TaxonomyKey): string =>
    `- ${key}: ${TAXONOMY[key].description}.\n  Allowed: ${TAXONOMY[key].values.join(', ')}`;

  return [
    `You are tagging an adult vertical short-form video for a content recommendation system.`,
    ``,
    `The ${frameCount} images below are frames sampled from ONE SINGLE VIDEO of ${durationSeconds.toFixed(1)} seconds,`,
    `in chronological order. They are not separate videos and not separate scenes to be`,
    `described individually. Classify the video AS A WHOLE: judge what is true for most of`,
    `its duration, and treat a trait that appears in only one frame as incidental.`,
    ``,
    `SINGLE-VALUE fields - return exactly one allowed value as a string:`,
    singleFields.map(describe).join('\n'),
    ``,
    `MULTI-VALUE fields - return an array of allowed values, or [] when none apply:`,
    multiFields.map(describe).join('\n'),
    ``,
    `Also return:`,
    `- aestheticScore: number 0..1, overall visual appeal.`,
    `- caption: one short sentence describing the video.`,
    `- confidence: object mapping the field names above to your confidence, 0..1.`,
    ``,
    `CORE RULES`,
    `- Use ONLY the allowed values listed above. Never invent a value, never rephrase one.`,
    `- Every field must be present. Multi-value fields use [] for "nothing applies".`,
    `- Do not repeat a value inside a multi-value field.`,
    `- Respond with a single JSON object and nothing else - no prose, no markdown fence.`,
    ``,
    `"unknown" VERSUS "none" - THESE ARE DIFFERENT`,
    `- "none" means you can see that the thing is absent. Example: nobody is having sex,`,
    `  so sexPosition is "none".`,
    `- "unknown" means you cannot tell from these frames. Example: the framing never shows`,
    `  enough to judge body type.`,
    `- Never substitute a guess for "unknown", and never use "unknown" for something you`,
    `  can plainly see is absent.`,
    ``,
    `WHO YOU ARE DESCRIBING`,
    `- These appearance fields describe the DOMINANT / MAIN performer only:`,
    `  adultAgeGroup, hairColor, bodyType, breastSize, buttSize, penisSize.`,
    `- If no single performer dominates the video, set those fields to "unknown".`,
    `- performerGender is the EXCEPTION: it describes the composition of everyone present,`,
    `  not just the main performer. Two women is "female"; a man and a woman is "mixed".`,
    `- performerCount also covers everyone present.`,
    ``,
    `WHAT NOT TO OUTPUT`,
    `- Never infer or report race or ethnicity. There is no field for it and no field`,
    `  should be used as a proxy for it.`,
    `- Everyone depicted is already verified as a consenting adult. adultAgeGroup is only`,
    `  an approximate apparent adult age band. On any borderline or uncertain case answer`,
    `  "unknown" rather than guessing a band.`,
    `- Describe apparent presentation as visible in the frames. Nothing here is a claim`,
    `  about anyone's real identity.`,
    ``,
    `DISAMBIGUATION RULES - follow these exactly`,
    `- Oral sex is an ACT, not a penetration type. Oral goes in actType as "oral".`,
    `  penetrationType has no oral value.`,
    `- Oral only, with no other penetration: sexPosition = "none", penetrationType = "none".`,
    `- Penetration with a toy: set the matching penetrationType (vaginal / anal), and put`,
    `  BOTH "toy_use" and "penetrative_sex" in actType.`,
    `- Several substantial sex positions with no dominant one: sexPosition = "mixed".`,
    `- Vaginal and anal at different moments of the video: penetrationType = "mixed".`,
    `- Vaginal and anal at the SAME time: penetrationType = "double_penetration".`,
    `- Locations change with no dominant one: setting = "other".`,
    `- explicitness: "nudity" is nudity without an explicit sex act; "explicit" requires an`,
    `  actual sex act; "suggestive" is sexualised but without explicit nudity or a sex act.`,
    `(taxonomy v${TAXONOMY_VERSION}, prompt v${PROMPT_VERSION})`,
  ].join('\n');
}
