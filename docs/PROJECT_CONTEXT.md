# Project Context

## Assignment

The project is a one-week technical assignment to build a minimal personalized recommendation system for vertical 18+ video content.

The evaluator is primarily interested in:

* engineering thought process;
* architecture;
* recommendation design;
* ability to reason about scale and cost.

A production-grade recommendation platform is explicitly out of scope.

## Current architectural direction

### Backend

The application is being built in Node.js and TypeScript.

Fastify is preferred for the HTTP API.

PostgreSQL is the primary relational database.

pgvector may be used for semantic/vector retrieval during candidate generation.

Redis provides:

* caching;
* prepared feed storage;
* BullMQ backing.

BullMQ handles background jobs in the MVP.

Production event streaming may later use Kafka or Redpanda, but Kafka must not be added to the MVP simply to make the architecture appear more sophisticated.

### Media

Video binaries are stored in S3-compatible object storage.

MinIO is used locally.

Metadata and analytical features belong in PostgreSQL.

The API should not act as the production video transport layer. At scale, clients obtain CDN-backed object-storage URLs.

### Video analysis

The current preferred approach is to preprocess videos before VLM inference.

Rather than blindly submitting complete videos, the application controls the amount of visual information sent to the model.

The strategy is adaptive sampling:

1. Inspect duration and metadata using FFprobe.
2. Select representative temporal frames.
3. Optionally detect scene transitions.
4. Add uniform samples to avoid missing changes occurring without camera cuts.
5. Deduplicate visually redundant samples.
6. Enforce a configurable maximum frame budget.
7. Analyze the selected samples.
8. Aggregate the model output.
9. Validate the result against a defined schema.
10. Persist normalized features.

For longer videos, analysis may be performed per temporal segment and then aggregated.

This design is chosen primarily for:

* cost control;
* predictable inference load;
* easier benchmarking;
* easier debugging;
* easier estimation of cost for 100k videos.

Native video input remains a possible fallback for cases where temporal reasoning is especially important.

### VLM selection

No final VLM has been selected.

Leading candidates:

* self-hosted Qwen3-VL;
* MiniCPM-V.

The selection should be made through a small benchmark on representative content.

Important benchmark dimensions:

* tag accuracy;
* missed tags;
* hallucinated tags;
* structured JSON validity;
* latency;
* GPU requirements;
* cost per video;
* projected cost per 100,000 videos.

Do not assume that a hosted multimodal API accepts explicit adult content. Verify provider terms before integrating one.

### Specialized classifiers

A specialized classifier such as NudeNet could eventually complement the VLM.

Its purpose would not be general semantic tagging.

Possible roles:

* cheap first-stage detection;
* handling narrow visual attributes;
* confidence cross-checking;
* reducing expensive VLM work where specialist inference is sufficient.

This optimization is lower priority than building the basic VLM pipeline.

### Recommendation system

The recommendation architecture should be two-stage.

Candidate generation narrows the corpus from potentially millions of videos to a manageable candidate set.

Possible candidate sources:

* vector/content similarity;
* affinity based on historical interactions;
* trending;
* fresh content;
* exploration.

Ranking then produces the final ordered feed.

Initial ranking may use a transparent weighted scoring model rather than immediately building a learned ranking model.

The architecture must allow a learned ranker to replace it later.

### User signals

Useful implicit and explicit feedback includes:

* impression;
* view;
* watch time;
* percentage watched;
* completion;
* like;
* skip.

These signals update the user profile asynchronously.

### Serving 3k RPS

Recommendation generation must not be performed from scratch for every HTTP request.

The target production architecture prepares feeds asynchronously.

Background:

events
→ profile update
→ recommendation generation
→ Redis

Request path:

client
→ API/load balancer
→ stateless Fastify instance
→ Redis
→ response

Video delivery:

client
→ CDN
→ object storage

This keeps expensive database/vector/ML work away from the hot HTTP path.

### MVP versus production

Implemented MVP:

* Node.js/TypeScript
* Fastify
* PostgreSQL
* pgvector if necessary
* Redis
* BullMQ
* MinIO/S3
* FFmpeg
* VLM adapter
* recommendation implementation
* Docker Compose

Architecture-only scale components:

* CDN
* managed object storage
* Kafka/Redpanda
* Redis Cluster
* horizontally scaled API instances
* horizontally scaled recommendation workers
* GPU inference workers
* potentially ClickHouse for behavioral analytics
* container orchestration

The distinction between these two layers must remain clear throughout the project.
