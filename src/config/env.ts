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
  INGEST_MIN_DURATION_SECONDS: num(1),
  INGEST_TMP_DIR: z.string().default('data/tmp'),
  DEMO_SOURCE_DIR: z.string().default('data/seed/videos'),
  /** Optional creator attribution for the demo corpus; absent is normal. */
  DEMO_MANIFEST_PATH: z.string().default('data/seed/manifest.json'),
  /** Poster frame is taken this far into the video, as a fraction of duration. */
  POSTER_POSITION_PCT: num(0.15),
  POSTER_WIDTH: int(360),

  // vision provider
  VISION_PROVIDER: z.enum(['mock', 'openai-compatible']).default('mock'),
  VISION_BASE_URL: z.string().default('http://localhost:11434/v1'),
  VISION_API_KEY: z.string().default('not-needed'),
  VISION_MODEL: z.string().default('qwen2.5vl:3b'),
  VISION_MODEL_VERSION: z.string().default('local-q4'),
  VISION_TIMEOUT_MS: int(180_000),
  VISION_MAX_RETRIES: int(1),

  // frame sampling - the primary cost lever.
  // Frames x pixels-per-frame is what a VLM bills for, so these bounds set the
  // per-video price. See src/analysis/sampling.ts.
  FRAMES_TIER_SHORT: int(6),
  FRAMES_TIER_MEDIUM: int(8),
  FRAMES_TIER_LONG: int(12),
  FRAMES_TIER_MAX: int(16),
  FRAMES_BOUND_SHORT: num(30),
  FRAMES_BOUND_MEDIUM: num(60),
  FRAMES_BOUND_LONG: num(120),
  /** Hard ceiling. No video may ever cost more than this many frames. */
  MAX_ANALYSIS_FRAMES: int(16),
  /** Floor after de-duplication, when enough distinct frames exist to reach it. */
  MIN_ANALYSIS_FRAMES: int(3),
  /** Longest edge sent to the model. Never upscales a smaller source. */
  FRAME_MAX_LONG_EDGE: int(768),
  FRAME_JPEG_QUALITY: int(4),
  DEDUP_HAMMING_THRESHOLD: int(6),
  /** Fraction trimmed from each end, to dodge intros, fades and end cards. */
  HEAD_TAIL_TRIM_PCT: num(0.05),
  /**
   * Opt-in scene-aware sampling. Off by default because detecting cuts requires
   * decoding every frame of the video, which is exactly the cost the sampling
   * design exists to avoid. See src/analysis/sceneDetect.ts.
   */
  SAMPLING_SCENE_AWARE: bool(false),
  SCENE_THRESHOLD: num(0.3),
  /** How far a uniform timestamp may move to land just after a nearby cut. */
  SCENE_SNAP_WINDOW_SECONDS: num(1.5),
  /** Debug artefacts (contact sheets, kept frames). Never part of the pipeline. */
  PREPROCESS_DEBUG_DIR: z.string().default('data/debug'),

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
  RANK_W_CREATOR_AFFINITY: num(0.2),
  DIVERSITY_LAMBDA: num(0.3),
  // Two independent diversity rules. The tag cap works on every video; the creator
  // cap only applies to videos that actually have a creatorId (it is nullable).
  DIVERSITY_MAX_SAME_TAG_IN_TOP10: int(3),
  DIVERSITY_MAX_SAME_CREATOR: int(2),

  // user profile
  PROFILE_HALFLIFE_DAYS: num(7),
  COLD_START_MIN_INTERACTIONS: int(5),

  // feed serving
  FEED_SIZE: int(50),
  FEED_TTL_SECONDS: int(3600),
  FEED_REFILL_WATERMARK: int(10),
  /**
   * Precomputed global trending feed, refreshed on a timer by a background worker.
   * It is what a personalised-feed cache miss is served from, so the request path
   * is Redis-only unconditionally - there is no code path from an HTTP request to
   * pgvector or to the ranker. See ARCHITECTURE.md "Serving 3k RPS".
   */
  TRENDING_FEED_SIZE: int(100),
  TRENDING_FEED_REFRESH_SECONDS: int(300),

  // workers
  /**
   * Bounded by GPU memory, not CPU. One quantised VLM inference at a time is all a
   * 6 GB card fits; raising this on such a card produces out-of-memory failures
   * partway through a corpus run. A 24 GB A10/L4 comfortably takes 2-4.
   */
  ANALYSIS_CONCURRENCY: int(1),
  EVENT_CONCURRENCY: int(4),
  FEED_CONCURRENCY: int(2),

  // cost model inputs
  /**
   * Actual rate paid for the benchmark GPU, in its billing currency. Kept in RUB
   * because that is what the invoice says; converting at an invented rate would
   * turn a measured number into a guess.
   */
  COST_GPU_HOURLY_RUB: num(41.06),
  /** Set only when a real, dated rate is known. 0 disables USD output entirely. */
  COST_RUB_PER_USD: num(0),
  COST_RUB_RATE_SOURCE: z.string().default(''),
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
