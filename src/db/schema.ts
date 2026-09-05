import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { TAXONOMY_DIM } from '../analysis/taxonomy.ts';
import type { VideoFeatures } from '../analysis/schema.ts';

export const videoStatus = pgEnum('video_status', [
  'ingested',
  'analyzing',
  'analyzed',
  'failed',
]);

export const eventType = pgEnum('event_type', [
  'impression',
  'view',
  'watch',
  'complete',
  'like',
  'skip',
  'dislike',
]);

export const videos = pgTable(
  'videos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    externalId: text('external_id'),
    /**
     * Creator attribution, both nullable: a local file or an anonymised source
     * legitimately has no known creator. There is deliberately no creators table
     * in the MVP - these two columns are all that creator affinity (ranking) and
     * the per-creator repeat cap (diversity) need. Rows with a null creatorId are
     * simply exempt from the cap.
     */
    creatorId: text('creator_id'),
    creatorHandle: text('creator_handle'),
    /** Object key in S3/MinIO. The API never proxies bytes; it presigns this. */
    s3Key: text('s3_key').notNull(),
    thumbKey: text('thumb_key'),
    durationSeconds: doublePrecision('duration_seconds').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    fps: doublePrecision('fps'),
    sizeBytes: integer('size_bytes').notNull(),
    /** sha256 of the file - the idempotency key for re-running ingestion. */
    checksum: text('checksum').notNull(),
    status: videoStatus('status').notNull().default('ingested'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('videos_checksum_uniq').on(t.checksum),
    index('videos_status_idx').on(t.status),
    index('videos_created_at_idx').on(t.createdAt.desc()),
    index('videos_creator_idx').on(t.creatorId),
  ],
);

export const videoFeatures = pgTable(
  'video_features',
  {
    videoId: uuid('video_id')
      .primaryKey()
      .references(() => videos.id, { onDelete: 'cascade' }),
    modelName: text('model_name').notNull(),
    modelVersion: text('model_version').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    taxonomyVersion: integer('taxonomy_version').notNull(),
    /** Zod-validated taxonomy output. GIN-indexed for tag-based candidate generation. */
    features: jsonb('features').$type<VideoFeatures>().notNull(),
    /** Unparsed model response, kept for debugging and for re-encoding after a taxonomy bump. */
    raw: jsonb('raw'),

    // Measured cost inputs. scripts/cost-model.ts extrapolates 100k videos from
    // these columns rather than from assumed numbers.
    framesUsed: integer('frames_used').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    latencyMs: integer('latency_ms'),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('video_features_gin').using('gin', t.features),
    index('video_features_model_idx').on(t.modelName, t.modelVersion),
  ],
);

export const videoEmbeddings = pgTable(
  'video_embeddings',
  {
    videoId: uuid('video_id')
      .primaryKey()
      .references(() => videos.id, { onDelete: 'cascade' }),
    taxonomyVersion: integer('taxonomy_version').notNull(),
    embedding: vector('embedding', { dimensions: TAXONOMY_DIM }).notNull(),
  },
  (t) => [
    index('video_embeddings_hnsw')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

/**
 * Denormalised engagement counters. Kept as a separate narrow table because it is
 * written on every event and read by trending; in production this is the row that
 * moves to Redis counters flushed periodically (see ARCHITECTURE.md).
 */
export const videoStats = pgTable(
  'video_stats',
  {
    videoId: uuid('video_id')
      .primaryKey()
      .references(() => videos.id, { onDelete: 'cascade' }),
    impressions: integer('impressions').notNull().default(0),
    views: integer('views').notNull().default(0),
    likes: integer('likes').notNull().default(0),
    skips: integer('skips').notNull().default(0),
    completions: integer('completions').notNull().default(0),
    watchMsSum: integer('watch_ms_sum').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('video_stats_updated_idx').on(t.updatedAt.desc())],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Materialised user profile. M6 must be able to rank with one read, so the
 * vector and the counters that describe it are stored rather than derived per
 * request.
 */
export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  taxonomyVersion: integer('taxonomy_version').notNull(),
  embedding: vector('embedding', { dimensions: TAXONOMY_DIM }).notNull(),
  /** Human-readable top tags, mirrored from the vector for tag-based candidates. */
  tagAffinity: jsonb('tag_affinity').$type<Record<string, number>>().notNull().default({}),
  /** Every event recorded for the user, including weightless impressions. */
  interactionCount: integer('interaction_count').notNull().default(0),
  /**
   * Events that could actually move the profile: non-zero weight AND an analysed
   * video behind them. This, not interactionCount, decides cold start - otherwise
   * scrolling past five videos would count as having taste.
   */
  effectiveSignalCount: integer('effective_signal_count').notNull().default(0),
  /** Decayed magnitudes, kept for diagnosis: is this profile built on likes or skips? */
  positiveSignal: doublePrecision('positive_signal').notNull().default(0),
  negativeSignal: doublePrecision('negative_signal').notNull().default(0),
  /** Interactions whose video had no analysed features - excluded from the vector. */
  skippedNoFeatures: integer('skipped_no_features').notNull().default(0),
  isColdStart: boolean('is_cold_start').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only behaviour log. The MVP's analytics store; ClickHouse at scale. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /**
     * Client-supplied idempotency key. Mobile clients retry on flaky networks, so
     * the same like can arrive several times; a unique index makes the duplicate a
     * no-op instead of a second contribution to the profile. Nullable because
     * server-generated events (seeds, simulations) have no client key.
     */
    eventId: text('event_id'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    type: eventType('type').notNull(),
    watchMs: integer('watch_ms'),
    /** Fraction of the video watched, 0..1. The watch ratio. */
    positionPct: real('position_pct'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('events_video_idx').on(t.videoId),
    index('events_user_video_idx').on(t.userId, t.videoId),
    uniqueIndex('events_event_id_uniq').on(t.eventId),
  ],
);

/**
 * Per-creator preference, kept out of the taxonomy vector on purpose.
 *
 * "Which creators does this user like?" is an identity question, not a content
 * one. Putting creators into the 110-dimension vector would mean a schema
 * migration and a full re-embed every time the creator set changes, and would let
 * creator identity leak into content similarity. A normal table instead of a JSON
 * blob on the profile because M6 needs "top creators for this user" as an indexed
 * query, and because scores are updated per creator rather than wholesale.
 */
export const userCreatorAffinity = pgTable(
  'user_creator_affinity',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    creatorId: text('creator_id').notNull(),
    /** Normalised, signed: negative means the user actively avoids this creator. */
    score: doublePrecision('score').notNull(),
    interactionCount: integer('interaction_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.creatorId] }),
    index('user_creator_affinity_top_idx').on(t.userId, t.score.desc()),
  ],
);

/** Feed exclusion set: what this user has already been shown. */
export const userSeen = pgTable(
  'user_seen',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    liked: boolean('liked').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.videoId] }),
    index('user_seen_user_idx').on(t.userId, t.lastSeenAt.desc()),
  ],
);

/** Raw SQL helper for pgvector cosine distance in hand-written queries. */
export const cosineDistance = (column: unknown, value: number[]) =>
  sql`${column} <=> ${JSON.stringify(value)}::vector`;
