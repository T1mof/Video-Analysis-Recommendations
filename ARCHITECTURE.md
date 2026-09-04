# Architecture

> **Status:** in progress. Sections are filled in as the milestones that decide them
> land. Ingestion, video analysis, the recommender, cost estimation and the failure
> matrix arrive with M2–M6. What is written here is decided and implemented, not
> aspirational — where something is designed but deliberately not built, it says so.

## Feature model: content vector vs ranking features

The system keeps two distinct kinds of signal apart, on purpose.

| | Content vector | Ranking features |
|---|---|---|
| **Answers** | "Is this the same *kind* of content?" | "Is this item good, fresh, or right for this user now?" |
| **Contents** | Taxonomy features only | `aestheticScore`, `duration`, `freshness`, `popularity`, `creatorAffinity`, tag fatigue, exploration bonus |
| **Storage** | `vector(83)` in pgvector, HNSW cosine | Columns in `video_stats` / `video_features`, read at rank time |
| **Used by** | Candidate generation (kNN) | Ranking stage, after candidates are retrieved |
| **Changing it costs** | Migration + full re-embedding (below) | Editing a weight in `.env` |

Continuous features *could* be embedded into the vector — with sensible
normalisation and weighting there is nothing mathematically wrong with it. They are
kept out for two practical reasons:

1. **Different semantics.** Content similarity and item quality are different
   questions. A single cosine score that answers both cannot be tuned for either.
2. **Different change cadence.** Ranking weights get re-tuned constantly during
   development. If popularity lived in the vector, every weight change would mean
   re-encoding every video, re-encoding every profile, and rebuilding the HNSW
   index. In the ranker it is one config value.

The user profile lives in the *same* space as video vectors (it is a time-decayed
weighted sum of the vectors of videos the user engaged with), which is what makes
`explainSimilarity()` possible: a dot product decomposes back into named tag
contributions, so the feed can show *why* an item was chosen rather than a bare
score.

**Known limitation.** A taxonomy-only vector cannot represent nuance outside the
taxonomy. The upgrade path is to concatenate a text embedding of the VLM caption,
or replace the whole encoder with a learned two-tower model — both preserve the
candidate-generation interface, so neither requires reworking the recommender.

## Taxonomy versioning and re-embedding

The vector dimension is **not** a code-only constant. It is baked into the
PostgreSQL column type, so changing the taxonomy is a data migration.

`TAXONOMY_LAYOUT` in `src/analysis/taxonomy.ts` is an explicit frozen array: index
*N* in that array **is** dimension *N* of every embedding ever written at that
taxonomy version. It is written out longhand rather than derived from object key
order, because key order is an accident of declaration — reordering a field would
silently shift every dimension after it and invalidate stored vectors with no error
anywhere.

### What a dimension change requires

Adding a single tag takes `vector(83)` to `vector(84)`. A `vector(83)` column
physically cannot store an 84-dimensional value, and pgvector refuses distance
operations between vectors of different dimensions. The full procedure:

```
  taxonomy v1 (83 dims)
        │
        ▼
  1. schema migration        vector(83) → vector(84)
        │
        ▼
  2. re-encode ALL video vectors        (video_embeddings)
        │
        ▼
  3. re-encode ALL user profiles        (user_profiles)
        │
        ▼
  4. rebuild the HNSW index
        │
        ▼
  taxonomy v2 (84 dims)
```

**Steps 2 and 3 are both mandatory.** A profile is a sum of video vectors, so a
half-migrated system has user profiles in the old space scoring videos in the new
one — which does not fail loudly, it just silently returns nonsense.

Re-encoding does **not** require re-running the VLM. Raw model output is retained
in `video_features.raw`, so steps 2 and 3 are a local recompute over data already
in Postgres — seconds for the demo corpus, and a bounded batch job at 100k.

### How the rule is enforced

`taxonomyVersion` is stored on every `video_embeddings` and `user_profiles` row, so
vectors from different spaces are always distinguishable and never mixed. Three
layers catch drift before it reaches data:

| Layer | Catches |
|---|---|
| Module-load assertion in `taxonomy.ts` | A taxonomy value added without appending it to the frozen layout |
| Pinned test (`TAXONOMY_DIM === 83`, first/last slots) | An accidental reorder or an unnoticed dimension change |
| `npm run db:migrate` dimension check | Code and database column type disagreeing, with the recovery procedure printed |

Rule of thumb: **new tags append at the end, never insert or reorder** — that keeps
existing dimensions stable, so step 2 is a re-encode rather than a semantic
remapping. It still changes `TAXONOMY_DIM`, so it still needs the full procedure
above.

### At scale

For a corpus where re-embedding is not instant, the same procedure runs online:
add a second column (or a second table) for the new dimension, backfill it while
the old vectors keep serving traffic, build the new HNSW index, then cut candidate
generation over and drop the old column. `taxonomyVersion` is what makes the
transition period safe — queries filter to one space explicitly rather than relying
on the backfill being complete.

## Serving the feed

### Hot path

```
GET /feed  →  Fastify  →  Redis  →  response
```

That is the whole request path. There is **no** code path from an HTTP request to
pgvector or to the ranker — not as a fallback, not behind a flag, not with a
timeout. This is the property the 3k RPS design rests on, so it is enforced by
construction rather than by configuration.

### How feeds get into Redis

| Route | Trigger |
|---|---|
| **Prewarm** | `npm run seed` builds demo users' feeds up front; signup triggers the same job in production |
| **Event-driven rebuild** | The event worker debounces a rebuild per user (every N events or T seconds) |
| **Watermark refill** | `/feed` enqueues a refill job when remaining cached items drop below `FEED_REFILL_WATERMARK` |
| **Explicit rebuild** | `POST /admin/feeds/rebuild` and `npm run rebuild-feeds` — the operator lever |

### Cache miss

A personalised-feed miss is served from a **precomputed global trending feed**,
also in Redis, refreshed on a timer by a background worker
(`TRENDING_FEED_REFRESH_SECONDS`). A miss therefore costs one extra Redis read and
nothing else.

```
GET /feed
   │
   ▼
Redis: feed:{userId}  ──hit──▶  response
   │
  miss
   │
   ▼
Redis: feed:global:trending  ──▶  response  (+ enqueue a personalised rebuild)
```

This matters beyond tidiness. A synchronous rebuild on miss — even one that is
off by default and timeout-bounded — is a **cache stampede waiting to happen**: the
moment Redis restarts or a deploy invalidates feeds, every concurrent request
simultaneously discovers a miss and starts doing pgvector work. The precomputed
trending feed converts that failure mode from "the ranker melts under 3k RPS" into
"users briefly see non-personalised content", which is a degradation rather than an
outage.

---

*Sections still to come: ingestion, video analysis and adaptive sampling, the
two-stage recommender, database model, cost estimation for 100k videos, the 3k RPS
capacity arithmetic, failure handling, scalability, tradeoffs, future improvements.*
