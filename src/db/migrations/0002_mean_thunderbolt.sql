-- Taxonomy v1 (83 dims) -> v2 (110 dims).
--
-- Hand-extended beyond what drizzle-kit generated. The generated output altered
-- the two column types only, which is not sufficient: a vector(83) value cannot be
-- cast to vector(110), and the HNSW index is built for the old dimension. This is
-- the full procedure documented in ARCHITECTURE.md "Taxonomy versioning and
-- re-embedding", executed in order.
--
-- v1 -> v2 is a RESTRUCTURE, not an append: fields were renamed (performerGenders
-- -> performerGender), collapsed from multi to single (hairColor, clothing,
-- penetrationType), removed (mood, cameraFraming) and added (adultAgeGroup,
-- breastSize, buttSize, penisSize, mediaType, sexPosition, appearanceFeatures).
-- Stored v1 model output therefore cannot be re-encoded into the v2 space - it
-- does not contain the answers v2 asks for. Affected videos must be re-analyzed,
-- not merely re-encoded.
--
-- Safe to run destructively here: the corpus has not been populated yet. On a
-- populated system this would instead be a dual-write + backfill, as described in
-- ARCHITECTURE.md.

-- 1. Drop the HNSW index; it is built for the old dimension.
DROP INDEX IF EXISTS "video_embeddings_hnsw";--> statement-breakpoint

-- 2. Discard vectors in the v1 space. They are unconvertible, and a half-migrated
--    system would score v1 profiles against v2 videos.
DELETE FROM "video_embeddings";--> statement-breakpoint
DELETE FROM "user_profiles";--> statement-breakpoint

-- 3. Discard v1 feature rows and return their videos to the analysis queue.
--    Unlike a pure append, re-encoding is not possible - the VLM must be re-run.
UPDATE "videos" SET "status" = 'ingested'
  WHERE "id" IN (SELECT "video_id" FROM "video_features" WHERE "taxonomy_version" < 2);--> statement-breakpoint
DELETE FROM "video_features" WHERE "taxonomy_version" < 2;--> statement-breakpoint

-- 4. Widen the columns.
ALTER TABLE "user_profiles" ALTER COLUMN "embedding" SET DATA TYPE vector(110);--> statement-breakpoint
ALTER TABLE "video_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(110);--> statement-breakpoint

-- 5. Rebuild the index at the new dimension.
CREATE INDEX "video_embeddings_hnsw" ON "video_embeddings"
  USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
