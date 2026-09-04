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
| **Backed by** | `TAXONOMY_LAYOUT`, frozen per version | Columns on `videos` / `video_stats` / `video_features` |
| **Storage** | `vector(110)` in pgvector, HNSW cosine | Columns in `video_stats` / `video_features`, read at rank time |
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

**Unknown is not a feature.** Values meaning "could not be determined" hold a slot
in the layout but encode as zero. Two videos whose hair colour is both
undeterminable have nothing in common, and letting `unknown` match `unknown` would
manufacture similarity out of missing information — concentrating badly-lit or
heavily-cropped footage into a false cluster. `none` and `other` encode normally:
"no sex position" and "a setting outside the list" are real observations, not
absent ones.

**Creator attribution.** `videos.creatorId` and `videos.creatorHandle` are both
nullable, and there is no `creators` table in the MVP: two columns are all that
creator affinity (ranking) and the per-creator repeat cap (diversity) consume, so a
join table would be structure with no current reader. Sources that cannot determine
a creator store `null`, which is an expected state — those videos are exempt from the
creator cap and contribute nothing to creator affinity. Because the tag-similarity
diversity rule is independent and applies to every video, diversification still works
for a corpus with no creator metadata at all.

> **The demo corpus's creators are synthetic.** `creator_01` … `creator_10` in
> `data/seed/manifest.json` are invented labels assigned round-robin by filename.
> They are **not** the real authors of the source material and must never be
> presented or exported as attribution. They exist only so creator affinity and the
> per-creator diversity cap have something to act on: ten creators × three videos is
> the smallest arrangement where both are observable. See `data/seed/README.md`.

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

Adding a single tag takes `vector(110)` to `vector(111)`. A `vector(110)` column
physically cannot store a 111-dimensional value, and pgvector refuses distance
operations between vectors of different dimensions. The full procedure:

```
  taxonomy vN (110 dims)
        │
        ▼
  1. schema migration        vector(110) → vector(111)
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
  taxonomy vN+1 (111 dims)
```

**Steps 2 and 3 are both mandatory.** A profile is a sum of video vectors, so a
half-migrated system has user profiles in the old space scoring videos in the new
one — which does not fail loudly, it just silently returns nonsense.

### Derived state must be recomputed too

The vectors are not the only thing downstream of the taxonomy. Anything computed
*from* them is stale the moment the space changes:

| Derived artefact | Why it goes stale |
|---|---|
| `user_profiles.embedding` | A sum of video vectors in the old space |
| `user_profiles.tagAffinity` | Mirrors the profile vector; keys are `TAXONOMY_LAYOUT` tags, some of which no longer exist |
| Prepared feeds in Redis (`feed:{userId}`) | Ranked and ordered using old-space similarity, and may reference videos that went back to `ingested` |

**Rule: a taxonomy version change invalidates every prepared feed.** After steps
1–4, profiles are rebuilt from the event log and every cached feed is dropped and
regenerated — a feed is a cache of a ranking decision, and that decision was made
in a space that no longer exists. Serving one after a taxonomy change would show
users a feed ordered by a similarity metric the system can no longer reproduce or
explain.

Feed rebuilds go through the existing explicit path (`POST /admin/feeds/rebuild`
and the prewarm at seed time), so no extra Redis machinery is needed for this — the
migration flushes the feed keys and lets the normal rebuild repopulate them. The
Redis-side implementation lands with the feed serving milestone; the ordering
constraint is recorded here because it is a property of the migration, not of the
cache.

For an **append-only** change, re-encoding does not require re-running the VLM: raw
model output is retained in `video_features.raw`, so steps 2 and 3 are a local
recompute over data already in Postgres — seconds for the demo corpus, and a
bounded batch job at 100k.

### Restructures are not re-encodes

A change that renames, splits, merges or removes a field is different in kind, and
the v1 → v2 migration (`0002_mean_thunderbolt.sql`) is the worked example. v2
renamed `performerGenders` → `performerGender`, collapsed `hairColor`, `clothing`
and `penetrationType` from multi to single, dropped `mood` and `cameraFraming`, and
added six new axes.

Stored v1 output **cannot** answer what v2 asks — nothing in a v1 row says what the
`sexPosition` or `breastSize` was. So the affected videos must be **re-analyzed**,
not re-encoded: the migration deletes the stale feature rows and returns those
videos to `ingested` so the analysis worker picks them up again.

The distinction matters for cost. An append is free; a restructure costs a full
re-run of the VLM over the corpus, which at 100k videos is the dominant line item
in the cost model. That is why taxonomy v2 was deliberately settled **before** the
corpus was populated, and is frozen until the first real-VLM benchmark.

### How the rule is enforced

`taxonomyVersion` is stored on every `video_embeddings` and `user_profiles` row, so
vectors from different spaces are always distinguishable and never mixed. Three
layers catch drift before it reaches data:

| Layer | Catches |
|---|---|
| Module-load assertion in `taxonomy.ts` | A taxonomy value added without appending it to the frozen layout |
| Pinned test (`TAXONOMY_DIM === 110`, version, first/last slots) | An accidental reorder or an unnoticed dimension change |
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
