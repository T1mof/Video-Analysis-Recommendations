import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Single validated source of configuration.
 *
 * Everything that changes analysis cost or ranking behaviour is a knob here rather
 * than a literal in the code, because "what does 100k videos cost?" is answered by
 * re-running the pipeline with different values, not by editing source.
 */

// Node's built-in .env loader; real environment variables always win.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const bool = (fallback: boolean) =>
  z.preprocess((v) => (v === undefined ? fallback : v === 'true' || v === '1'), z.boolean());

const int = (fallback: number) => z.coerce.number().int().default(fallback);
const num = (fallback: number) => z.coerce.number().default(fallback);

const schema = z.object({
  // runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: int(3000),

  // datastores
  DATABASE_URL: z.string().default('postgres://app:app@localhost:5432/videorec'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // object storage
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('videos'),
  S3_ACCESS_KEY_ID: z.string().default('minioadmin'),
  S3_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
  S3_FORCE_PATH_STYLE: bool(true),
  MEDIA_URL_TTL_SECONDS: int(3600),

  // ingestion
  INGEST_MAX_DURATION_SECONDS: int(300),
  INGEST_REQUIRE_VERTICAL: bool(true),
  INGEST_TMP_DIR: z.string().default('data/tmp'),

  // vision provider
  VISION_PROVIDER: z.enum(['mock', 'openai-compatible']).default('mock'),
  VISION_BASE_URL: z.string().default('http://localhost:11434/v1'),
  VISION_API_KEY: z.string().default('not-needed'),
  VISION_MODEL: z.string().default('qwen2.5vl:3b'),
  VISION_MODEL_VERSION: z.string().default('local-q4'),
  VISION_TIMEOUT_MS: int(180_000),
  VISION_MAX_RETRIES: int(1),

  // frame sampling - the primary cost lever
  FRAMES_TIER_SHORT: int(6),
  FRAMES_TIER_MEDIUM: int(8),
  FRAMES_TIER_LONG: int(12),
  FRAMES_TIER_XLONG: int(16),
  FRAMES_TIER_XXLONG: int(24),
  FRAMES_MAX_BUDGET: int(24),
  FRAMES_BOUND_SHORT: num(20),
  FRAMES_BOUND_MEDIUM: num(45),
  FRAMES_BOUND_LONG: num(90),
  FRAMES_BOUND_XLONG: num(180),
  SCENE_THRESHOLD: num(0.3),
  FRAME_WIDTH: int(512),
  FRAME_JPEG_QUALITY: int(4),
  DEDUP_HAMMING_THRESHOLD: int(6),
  HEAD_TAIL_TRIM_PCT: num(0.05),

  // candidate generation
  CAND_SIMILAR_K: int(200),
  CAND_TAG_K: int(100),
  CAND_TRENDING_K: int(100),
  CAND_FRESH_K: int(50),
  CAND_EXPLORE_K: int(50),
  TRENDING_WINDOW_HOURS: int(72),

  // ranking
  RANK_W_AFFINITY: num(1.0),
  RANK_W_QUALITY: num(0.15),
  RANK_W_FRESHNESS: num(0.2),
  RANK_W_POPULARITY: num(0.25),
  RANK_W_FATIGUE: num(0.35),
  RANK_W_EXPLORATION: num(0.1),
  DIVERSITY_LAMBDA: num(0.3),
  DIVERSITY_MAX_SAME_TAG_IN_TOP10: int(3),

  // user profile
  PROFILE_HALFLIFE_DAYS: num(7),
  COLD_START_MIN_INTERACTIONS: int(5),

  // feed serving
  FEED_SIZE: int(50),
  FEED_TTL_SECONDS: int(3600),
  FEED_REFILL_WATERMARK: int(10),
  FEED_SYNC_FALLBACK: bool(true),

  // workers
  ANALYSIS_CONCURRENCY: int(2),
  EVENT_CONCURRENCY: int(4),
  FEED_CONCURRENCY: int(2),

  // cost model inputs
  COST_GPU_HOURLY_USD: num(0.6),
  COST_HOSTED_INPUT_USD_PER_MTOK: num(0.2),
  COST_HOSTED_OUTPUT_USD_PER_MTOK: num(0.6),
  COST_STORAGE_USD_PER_GB_MONTH: num(0.023),
  COST_AVG_VIDEO_MB: num(8),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = load();

/** Frame budget for a video of the given duration, honouring the hard cap. */
export function frameBudgetFor(durationSeconds: number): number {
  const tier =
    durationSeconds <= env.FRAMES_BOUND_SHORT
      ? env.FRAMES_TIER_SHORT
      : durationSeconds <= env.FRAMES_BOUND_MEDIUM
        ? env.FRAMES_TIER_MEDIUM
        : durationSeconds <= env.FRAMES_BOUND_LONG
          ? env.FRAMES_TIER_LONG
          : durationSeconds <= env.FRAMES_BOUND_XLONG
            ? env.FRAMES_TIER_XLONG
            : env.FRAMES_TIER_XXLONG;
  return Math.min(tier, env.FRAMES_MAX_BUDGET);
}
