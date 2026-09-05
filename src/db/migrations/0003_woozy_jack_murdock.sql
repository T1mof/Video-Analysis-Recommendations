ALTER TYPE "public"."event_type" ADD VALUE 'dislike';--> statement-breakpoint
CREATE TABLE "user_creator_affinity" (
	"user_id" uuid NOT NULL,
	"creator_id" text NOT NULL,
	"score" double precision NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_creator_affinity_user_id_creator_id_pk" PRIMARY KEY("user_id","creator_id")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "effective_signal_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "positive_signal" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "negative_signal" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "skipped_no_features" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "is_cold_start" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_creator_affinity" ADD CONSTRAINT "user_creator_affinity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_creator_affinity_top_idx" ON "user_creator_affinity" USING btree ("user_id","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_user_video_idx" ON "events" USING btree ("user_id","video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_event_id_uniq" ON "events" USING btree ("event_id");