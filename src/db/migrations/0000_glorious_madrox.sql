CREATE TYPE "public"."event_type" AS ENUM('impression', 'view', 'watch', 'complete', 'like', 'skip');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('ingested', 'analyzing', 'analyzed', 'failed');--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"type" "event_type" NOT NULL,
	"watch_ms" integer,
	"position_pct" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"taxonomy_version" integer NOT NULL,
	"embedding" vector(83) NOT NULL,
	"tag_affinity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_seen" (
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"liked" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_seen_user_id_video_id_pk" PRIMARY KEY("user_id","video_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_embeddings" (
	"video_id" uuid PRIMARY KEY NOT NULL,
	"taxonomy_version" integer NOT NULL,
	"embedding" vector(83) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_features" (
	"video_id" uuid PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"taxonomy_version" integer NOT NULL,
	"features" jsonb NOT NULL,
	"raw" jsonb,
	"frames_used" integer NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_stats" (
	"video_id" uuid PRIMARY KEY NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"skips" integer DEFAULT 0 NOT NULL,
	"completions" integer DEFAULT 0 NOT NULL,
	"watch_ms_sum" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"external_id" text,
	"s3_key" text NOT NULL,
	"thumb_key" text,
	"duration_seconds" double precision NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"fps" double precision,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"status" "video_status" DEFAULT 'ingested' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_seen" ADD CONSTRAINT "user_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_seen" ADD CONSTRAINT "user_seen_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_embeddings" ADD CONSTRAINT "video_embeddings_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_features" ADD CONSTRAINT "video_features_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_stats" ADD CONSTRAINT "video_stats_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_user_created_idx" ON "events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_video_idx" ON "events" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "user_seen_user_idx" ON "user_seen" USING btree ("user_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "video_embeddings_hnsw" ON "video_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "video_features_gin" ON "video_features" USING gin ("features");--> statement-breakpoint
CREATE INDEX "video_features_model_idx" ON "video_features" USING btree ("model_name","model_version");--> statement-breakpoint
CREATE INDEX "video_stats_updated_idx" ON "video_stats" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "videos_checksum_uniq" ON "videos" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "videos_status_idx" ON "videos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "videos_created_at_idx" ON "videos" USING btree ("created_at" DESC NULLS LAST);