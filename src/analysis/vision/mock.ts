import { PROMPT_VERSION, videoFeaturesSchema, type VideoFeatures } from '../schema.ts';
import type { VideoAnalysisInput, VisionAnalysis, VisionProvider } from './provider.ts';

/**
 * SYNTHETIC provider - dev and test only. It never looks at a single pixel.
 *
 * Features are derived from a hash of the video id, so a video whose real content
 * is an animated SFW monologue can easily be labelled as an explicit live-action
 * scene. That is fine for exercising the pipeline and meaningless as a description
 * of the corpus, which is why `synthetic` is true and every human-facing surface
 * is required to say so.
 *
 * Two jobs. First, it lets the whole pipeline - worker, persistence, profile,
 * candidates, ranking, feed - be built and tested with no GPU and no network, so
 * the riskiest dependency in the project stops being a blocker for everything
 * downstream. Second, it makes tests reproducible: the same video always yields
 * the same features.
 *
 * It does NOT emit uniform noise. Random tags across 30 videos would produce a
 * corpus with no cluster structure, and a recommender demo over that shows nothing
 * - every video would look equally (dis)similar to every profile. Instead each
 * video is assigned to one of a few coherent archetypes, so "videos like this one"
 * is a meaningful question even on synthetic data.
 *
 * It deliberately does NOT read data/gold/labels.json. Seeding the mock from the
 * hand-reviewed labels would leak ground truth into the system under test and make
 * the benchmark measure itself.
 *
 * Token usage is reported as null on purpose. Inventing plausible token counts
 * would silently poison the cost model, whose entire value is that it
 * extrapolates from measured numbers.
 */

const MODEL_NAME = 'mock';
const MODEL_VERSION = 'synthetic-archetype-v1';

/** FNV-1a: small, dependency-free, and stable across runs and platforms. */
function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 - tiny seeded PRNG, enough for picking from small pools. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length)]!;
}

/** Picks a subset of size 0..max, deterministically. */
function pickSome<T>(rng: () => number, pool: readonly T[], max: number): T[] {
  const count = Math.floor(rng() * (max + 1));
  const shuffled = [...pool].sort(() => rng() - 0.5);
  return shuffled.slice(0, count);
}

/** Taxonomy fields only; the generated extras are filled in by the provider. */
type ArchetypeFeatures = Omit<VideoFeatures, 'caption' | 'confidence' | 'aestheticScore'>;

interface Archetype {
  readonly label: string;
  readonly build: (rng: () => number) => ArchetypeFeatures;
}

/**
 * Six coherent content clusters. They exist so a user who likes, say, outdoor
 * swimwear content has something consistent to like - which is exactly what the
 * recommender has to detect.
 */
const ARCHETYPES: readonly Archetype[] = [
  {
    label: 'solo lingerie bedroom',
    build: (rng) => ({
      performerCount: 'solo',
      performerGender: 'female',
      adultAgeGroup: pick(rng, ['18_24', '25_34'] as const),
      hairColor: pick(rng, ['blonde', 'blonde', 'dark'] as const),
      bodyType: pick(rng, ['slim', 'athletic'] as const),
      breastSize: pick(rng, ['medium', 'large'] as const),
      buttSize: pick(rng, ['medium', 'small'] as const),
      penisSize: 'unknown',
      mediaType: 'live_action',
      setting: pick(rng, ['bedroom', 'bedroom', 'living_room'] as const),
      clothing: 'lingerie',
      sexPosition: 'none',
      penetrationType: 'none',
      cameraStyle: pick(rng, ['standard', 'selfie'] as const),
      explicitness: pick(rng, ['suggestive', 'suggestive', 'nudity'] as const),
      productionQuality: pick(rng, ['amateur', 'semi_pro'] as const),
      appearanceFeatures: pickSome(rng, ['tattoos', 'piercings'] as const, 1),
      actType: pick(rng, [['posing'], ['posing', 'dancing'], ['undressing']] as const).slice(),
      fetishTags: pickSome(rng, ['stockings'] as const, 1),
    }),
  },
  {
    label: 'outdoor swimwear',
    build: (rng) => ({
      performerCount: 'solo',
      performerGender: 'female',
      adultAgeGroup: pick(rng, ['18_24', '25_34'] as const),
      hairColor: pick(rng, ['dark', 'blonde', 'red'] as const),
      bodyType: pick(rng, ['athletic', 'curvy'] as const),
      breastSize: pick(rng, ['small', 'medium'] as const),
      buttSize: pick(rng, ['medium', 'large'] as const),
      penisSize: 'unknown',
      mediaType: 'live_action',
      setting: pick(rng, ['outdoor', 'pool', 'gym'] as const),
      clothing: pick(rng, ['swimwear', 'casual'] as const),
      sexPosition: 'none',
      penetrationType: 'none',
      cameraStyle: pick(rng, ['standard', 'selfie'] as const),
      explicitness: pick(rng, ['sfw', 'suggestive'] as const),
      productionQuality: pick(rng, ['amateur', 'semi_pro'] as const),
      appearanceFeatures: pickSome(rng, ['tattoos'] as const, 1),
      actType: pick(rng, [['dancing'], ['posing', 'dancing'], ['talking']] as const).slice(),
      fetishTags: pickSome(rng, ['public'] as const, 1),
    }),
  },
  {
    label: 'explicit duo bedroom',
    build: (rng) => ({
      performerCount: 'duo',
      performerGender: 'mixed',
      adultAgeGroup: pick(rng, ['25_34', '35_44'] as const),
      hairColor: pick(rng, ['blonde', 'dark'] as const),
      bodyType: pick(rng, ['slim', 'curvy', 'average'] as const),
      breastSize: pick(rng, ['medium', 'large'] as const),
      buttSize: pick(rng, ['medium', 'large'] as const),
      penisSize: pick(rng, ['medium', 'large'] as const),
      mediaType: 'live_action',
      setting: pick(rng, ['bedroom', 'living_room'] as const),
      clothing: 'nude',
      sexPosition: pick(rng, ['missionary', 'doggy', 'riding', 'mixed'] as const),
      penetrationType: pick(rng, ['vaginal', 'vaginal', 'mixed'] as const),
      cameraStyle: pick(rng, ['standard', 'pov'] as const),
      explicitness: 'explicit',
      productionQuality: pick(rng, ['amateur', 'semi_pro', 'professional'] as const),
      appearanceFeatures: pickSome(rng, ['tattoos', 'piercings'] as const, 2),
      actType: ['penetrative_sex', ...pickSome(rng, ['kissing', 'oral'] as const, 1)],
      fetishTags: pickSome(rng, ['stockings', 'latex_leather'] as const, 1),
    }),
  },
  {
    label: 'pov explicit',
    build: (rng) => ({
      performerCount: 'duo',
      performerGender: 'mixed',
      adultAgeGroup: pick(rng, ['18_24', '25_34'] as const),
      hairColor: pick(rng, ['dark', 'blonde', 'colored'] as const),
      bodyType: pick(rng, ['slim', 'athletic'] as const),
      breastSize: pick(rng, ['small', 'medium'] as const),
      buttSize: 'medium',
      penisSize: pick(rng, ['medium', 'large'] as const),
      mediaType: 'live_action',
      setting: pick(rng, ['bedroom', 'bathroom', 'car'] as const),
      clothing: pick(rng, ['partially_nude', 'nude'] as const),
      sexPosition: pick(rng, ['riding', 'reverse_riding', 'other'] as const),
      // 'oral' is deliberately not a penetrationType in taxonomy v2 - oral acts
      // are recorded in actType, and 'none' is correct when that is all there is.
      penetrationType: pick(rng, ['vaginal', 'anal', 'none'] as const),
      cameraStyle: 'pov',
      explicitness: 'explicit',
      productionQuality: 'amateur',
      appearanceFeatures: pickSome(rng, ['piercings'] as const, 1),
      actType: pick(rng, [['oral'], ['penetrative_sex'], ['manual', 'oral']] as const).slice(),
      fetishTags: pickSome(rng, ['feet', 'voyeur'] as const, 1),
    }),
  },
  {
    label: 'animated',
    build: (rng) => ({
      performerCount: pick(rng, ['solo', 'duo'] as const),
      performerGender: pick(rng, ['female', 'mixed'] as const),
      adultAgeGroup: 'unknown',
      hairColor: pick(rng, ['colored', 'other', 'unknown'] as const),
      bodyType: pick(rng, ['slim', 'curvy', 'unknown'] as const),
      breastSize: pick(rng, ['medium', 'large'] as const),
      buttSize: pick(rng, ['medium', 'large'] as const),
      penisSize: 'unknown',
      mediaType: 'animated',
      setting: pick(rng, ['other', 'bedroom', 'studio'] as const),
      clothing: pick(rng, ['costume', 'lingerie', 'other'] as const),
      sexPosition: pick(rng, ['none', 'other', 'unknown'] as const),
      penetrationType: pick(rng, ['none', 'other'] as const),
      cameraStyle: pick(rng, ['standard', 'mixed'] as const),
      explicitness: pick(rng, ['suggestive', 'nudity'] as const),
      productionQuality: pick(rng, ['semi_pro', 'professional'] as const),
      appearanceFeatures: [],
      actType: pick(rng, [['posing'], ['dancing'], ['talking']] as const).slice(),
      fetishTags: pickSome(rng, ['cosplay', 'roleplay'] as const, 2),
    }),
  },
  {
    label: 'talking / sfw',
    build: (rng) => ({
      performerCount: 'solo',
      performerGender: 'female',
      adultAgeGroup: pick(rng, ['25_34', '35_44'] as const),
      hairColor: pick(rng, ['dark', 'red', 'blonde'] as const),
      bodyType: pick(rng, ['average', 'slim'] as const),
      breastSize: pick(rng, ['small', 'medium'] as const),
      buttSize: pick(rng, ['small', 'medium'] as const),
      penisSize: 'unknown',
      mediaType: 'live_action',
      setting: pick(rng, ['bedroom', 'kitchen', 'office', 'living_room'] as const),
      clothing: pick(rng, ['casual', 'uniform'] as const),
      sexPosition: 'none',
      penetrationType: 'none',
      cameraStyle: pick(rng, ['selfie', 'standard'] as const),
      explicitness: pick(rng, ['sfw', 'suggestive'] as const),
      productionQuality: 'amateur',
      appearanceFeatures: pickSome(rng, ['tattoos', 'piercings'] as const, 1),
      actType: pick(rng, [['talking'], ['talking', 'posing'], ['massage']] as const).slice(),
      fetishTags: pickSome(rng, ['roleplay'] as const, 1),
    }),
  },
];

export class MockVisionProvider implements VisionProvider {
  readonly name = 'mock';
  readonly modelName = MODEL_NAME;
  readonly modelVersion = MODEL_VERSION;
  readonly synthetic = true;

  async analyze(input: VideoAnalysisInput): Promise<VisionAnalysis> {
    const startedAt = Date.now();

    const rng = mulberry32(hashSeed(input.videoId));
    const archetype = ARCHETYPES[hashSeed(input.videoId) % ARCHETYPES.length]!;
    const base = archetype.build(rng);

    const features: VideoFeatures = {
      ...base,
      aestheticScore: Math.round((0.35 + rng() * 0.6) * 100) / 100,
      // The caption states its own provenance, so a synthetic row is recognisable
      // even when read straight out of the database with no surrounding context.
      caption: `[SYNTHETIC - not real analysis] Mock archetype "${archetype.label}" for a ${input.durationSeconds.toFixed(1)}s video (${input.frames.length} frames sampled).`,
      confidence: {},
    };

    // Validate against the same schema a real model must satisfy. If the taxonomy
    // changes and the mock is not updated, this fails loudly here rather than
    // writing invalid rows.
    const validated = videoFeaturesSchema.parse(features);

    return {
      features: validated,
      raw: { provider: 'mock', synthetic: true, archetype: archetype.label },
      modelName: this.modelName,
      modelVersion: this.modelVersion,
      promptVersion: PROMPT_VERSION,
      // Deliberately null: fabricated token counts would corrupt the cost model.
      usage: { tokensIn: null, tokensOut: null },
      latencyMs: Date.now() - startedAt,
      attempts: 1,
    };
  }
}
