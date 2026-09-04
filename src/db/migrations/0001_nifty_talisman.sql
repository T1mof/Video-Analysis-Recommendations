ALTER TABLE "videos" ADD COLUMN "creator_id" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "creator_handle" text;--> statement-breakpoint
CREATE INDEX "videos_creator_idx" ON "videos" USING btree ("creator_id");