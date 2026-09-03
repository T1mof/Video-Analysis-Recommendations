# Project Instructions

## Goal

Build a one-week MVP of a personalized vertical-video recommendation system.

The goal of the assignment is to demonstrate engineering thinking, recommendation-system design, video-analysis design, cost awareness, and high-load architecture. Do not attempt to build a production TikTok clone.

Prioritize architecture and recommendation logic over boilerplate code.

## Required demo scope

* Ingest approximately 20–30 vertical videos for demonstration.
* Analyze videos and extract structured features useful for recommendation.
* Implement a minimal personalized recommendation algorithm.
* Estimate video-analysis cost for 100,000 videos.
* Design, but do not fully implement, a production architecture capable of approximately 3,000 requests/second.
* Produce README.md and ARCHITECTURE.md.
* The final system must be demoable end-to-end.

## Core stack

Use:

* Node.js
* TypeScript
* Fastify
* PostgreSQL
* pgvector
* Redis
* BullMQ
* S3-compatible object storage
* MinIO for local development
* FFmpeg / FFprobe
* Playwright where scraping requires a browser
* Zod for runtime validation
* Drizzle for database access
* Vitest for tests
* Docker Compose for the local environment

Do not introduce another backend language unless absolutely necessary for model inference.

## Architecture principles

Keep the MVP simple.

MVP:

* Fastify API
* PostgreSQL + pgvector
* Redis
* BullMQ
* S3 / MinIO
* background workers

Production-scale components such as Kafka/Redpanda, Kubernetes, ClickHouse, Redis Cluster and separate horizontally scaled services should be described in ARCHITECTURE.md, not implemented unless there is a compelling reason.

Do not overengineer the MVP.

## Media storage

Original videos belong in S3-compatible object storage.

Store video metadata and extracted features in PostgreSQL.

Do not permanently store all sampled frames. Frames should normally be temporary analysis artifacts.

Clients should eventually receive CDN/object-storage URLs instead of having the Node.js API proxy video bytes.

## Video analysis

The default analysis strategy is controlled adaptive frame sampling rather than sending the complete video blindly to a VLM.

Pipeline:

video
→ FFprobe metadata
→ adaptive sampling
→ VLM analysis
→ schema validation
→ feature storage

Sampling should combine:

* temporal/uniform sampling;
* scene-aware sampling where useful;
* deduplication;
* a maximum frame budget.

Short videos may require approximately 6–8 representative frames.
Medium videos may require approximately 8–12.
Longer 1–3 minute videos may use approximately 16–24 frames.

For sufficiently long or complex videos, split analysis into temporal segments and aggregate segment-level features.

Do not decode or analyze every video frame.

The frame budget must remain configurable because analysis cost is a primary design constraint.

## Vision models

Do not tightly couple the application to one model provider.

Use an abstraction similar to:

interface VisionProvider {
analyze(input: VideoAnalysisInput): Promise<VideoFeatures>;
}

Current candidate VLMs:

* self-hosted Qwen3-VL
* MiniCPM-V

The final model has not yet been selected and should be benchmarked on representative videos before committing.

Hosted APIs must not be assumed to support explicit adult material. Provider policy must be checked before using a hosted model.

NudeNet or another specialized classifier is optional and is NOT required for the first MVP. It may later be introduced as a cheap specialist stage or confidence cross-check.

## Feature extraction

Use a predefined taxonomy and structured output instead of allowing the VLM to invent arbitrary tags.

Store:

* normalized features;
* confidence where available;
* model name;
* model version;
* raw model response where useful;
* analysis timestamp.

Validate model output with Zod before storing it.

## Recommendation architecture

Use a two-stage recommendation design:

1. Candidate generation
2. Ranking

Potential candidate sources include:

* semantic similarity;
* user preferences;
* popular/trending content;
* fresh content;
* exploration.

Do not scan and rerank the entire video database on every feed request.

User behavior should include signals such as:

* impression;
* view;
* watch time;
* completion;
* like;
* skip.

Maintain a user preference/profile representation that can be updated from those signals.

## Feed serving

The heavy recommendation work should not run synchronously on the main request path.

Preferred model:

user events
→ background processing
→ profile update
→ candidate generation/ranking
→ prepared feed
→ Redis

Hot path:

GET /feed
→ Fastify
→ Redis
→ response

This distinction is important for the 3,000 RPS architecture.

## Development rules

Before making a significant implementation change:

1. Inspect the existing code and relevant documentation.
2. State a short implementation plan.
3. Prefer the smallest solution that satisfies the assignment.
4. Do not replace architectural choices without explaining why.
5. Keep external services behind interfaces.
6. Avoid premature abstractions that do not serve the MVP.
7. Add or update tests for meaningful behavior.
8. Run relevant tests, type checking and linting after changes.
9. Do not claim something works unless it has been verified.

When a design decision has significant tradeoffs, explain them before implementing it.

## Documentation

Keep README.md focused on:

* what the project does;
* setup;
* local execution;
* demo flow;
* API usage.

Keep ARCHITECTURE.md focused on:

* requirements and assumptions;
* data flow;
* ingestion;
* video analysis;
* recommendation system;
* database model;
* cost estimation;
* 3,000 RPS design;
* failure handling;
* scalability;
* tradeoffs;
* future improvements.

Whenever implementation and ARCHITECTURE.md disagree, point it out rather than silently changing one.

## Primary constraint

This is a one-week technical assignment.

Optimize for a small, understandable, demonstrable system with strong engineering reasoning—not maximum feature count.
