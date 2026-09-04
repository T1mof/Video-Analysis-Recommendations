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

### Ingestion and content sources

Ingestion sits behind a `VideoSource` interface. Every source yields the same
candidate items, and the rest of the pipeline — validation, deduplication, storage,
analysis — is shared and source-agnostic.

#### Priority: the scraper is not on the critical path

The assignment names Fansly and Fanvue as example sources, but the same task
statement explicitly allows content from anywhere ("можете взять откуда угодно").
Per the team lead's clarification, **a full Fansly/Fanvue scraper is not a
requirement of the MVP**. It is an optional bonus, scheduled last.

The order of work is therefore:

1. **Close the main pipeline end to end first** — local video source → object
   storage → analysis → features → user profile → recommendations → prepared feed →
   benchmark → documentation. This is the deliverable being graded.
2. **`DemoVideoSource` is the source used for the mandatory demonstration**, backed
   by 20–30 local vertical videos. The demo must never depend on a live third-party
   site being reachable, unblocked, or logged in.
3. **Only once the above is complete**, and only if time remains, implement a
   best-effort `FanslySource` or `FanvueSource` using ordinary Playwright
   navigation.
4. **The scraper must never block or delay the main MVP.** If it is unfinished at
   the deadline, that is an acceptable outcome and is documented as such.

#### Scope limits on the scraper

Should the scraper be attempted, it uses plain browser automation only. It does
**not** attempt to defeat Cloudflare challenges, solve CAPTCHAs, rotate proxies, or
otherwise circumvent anti-bot protection. Authentication, where needed, is a
one-time manual login whose session state is reused.

This is both a scope decision and a deliberate one: anti-bot evasion consumes
time, produces nothing the evaluator is assessing, and works against the terms of
the target sites. Ingested material stays local and is not redistributed.

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

The pipeline has four distinct stages, kept separate so each can be reasoned about,
tuned and replaced on its own:

```
multi-source candidate generation
        → union
        → deduplication
        → filtering
        → weighted ranking
        → diversification
```

The overall shape is inspired by the publicly described approach of X: retrieve from
several independent candidate sources, filter, score, then diversify. The learned
components of that design are deliberately not reproduced here — see "Ranking".

#### 1. Candidate generation

Candidate generation narrows the corpus from potentially millions of videos to a
manageable candidate set. It is always **multi-source**; no single source decides
the feed. The five sources:

* **vector similarity** — taxonomy-vector nearest neighbours to the user profile;
* **explicit tag affinity** — direct lookup on the user's strongest preferred tags;
* **popular**;
* **fresh**;
* **exploration** — a small pool for discovering interests the profile does not yet reflect.

Vector similarity and tag affinity overlap but are not redundant: the first
generalises to tag combinations the user has never seen, the second is exact,
explainable, and keeps working if the vector index is unavailable.

Every source returns nothing more than a **plain set of candidate video ids**. No
source filters, scores, or orders — those are common stages that run once,
afterwards, over the merged set. Each source is independently capped, so one source
degrading or returning nothing cannot starve the feed.

#### 2. Union and deduplication

Sources are merged into one set, and a video surfaced by several sources collapses
to a single candidate (retaining which sources produced it, for debugging and for
the demo panel).

#### 3. Filtering

A separate stage over the merged set, not something folded into each source. It
removes candidates that must never reach ranking:

* already seen by this user;
* **any video whose status is not `analyzed`** — an unanalyzed video has no features
  and therefore cannot be ranked. This single rule also covers ingested-but-pending,
  failed, and in-progress videos, which is why no separate `unavailable` status
  exists.

Keeping this separate means an exclusion rule is written once rather than repeated
in every candidate query, and the filtered-out counts are observable per reason.

#### 4. Ranking

A transparent weighted scoring model, not a learned ranker.

Numeric signals — popularity, freshness, creator affinity, duration, quality prior —
are applied **here**, not inside the taxonomy vector. The vector answers "is this the
same kind of content?"; ranking answers "is this item good, and right for this user
now?". Separating them also means ranking weights can be re-tuned without re-encoding
any vectors.

A learned ranker remains a later replacement for this stage; the interface is chosen
so it can drop in without disturbing candidate generation.

#### 5. Diversification

Applied after ranking, deliberately simple. **Two independent rules**, not one:

* **cap repeats of the same creator** in the returned window;
* **penalise consecutive videos with overly similar tags**.

They are kept separate because they fail differently. A feed can show ten different
creators shooting near-identical content, or one creator across genuinely varied
content; only one rule catches each case.

Creator attribution is nullable (see "Creators" below), so the creator cap applies
only to videos that actually carry a `creatorId`. The tag rule applies to everything
and is what keeps diversification working for sources with no creator metadata.

Without this stage the ranker converges on a narrow slice of the catalogue and the
feed becomes monotonous even though every individual item scores well.

#### Creators

`videos` carries two nullable columns, `creatorId` and `creatorHandle`. There is
**no creators table in the MVP** — these two columns are everything creator affinity
and the per-creator cap require, and a join table would be architecture without a
current consumer.

Sources that cannot determine a creator store both as `null`. That is an expected
state, not a defect: such videos are simply exempt from the creator cap and
contribute nothing to creator affinity.

#### Cold start

A user with no history is served a cold-start feed of popular, fresh and
deliberately diverse videos. The profile takes over as interactions accumulate.

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

Feedback is **bidirectional**: the profile moves in both directions rather than only
accumulating positives.

* Positive signals — `like`, a high watch ratio, `complete` — strengthen the
  corresponding preferences.
* Negative signals — `skip`, a low watch ratio — weaken them.

A positive-only profile drifts toward whatever the user has already been shown and
can never recover from a bad recommendation streak, because there is no mechanism
that pushes a preference back down.

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
* `DemoVideoSource` (local videos) — the source the demo runs on

Optional, only if time remains after everything above:

* best-effort `FanslySource` / `FanvueSource` via plain Playwright

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
