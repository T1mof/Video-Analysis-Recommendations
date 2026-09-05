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

## Video analysis

### Flow

```
video in object storage
      │
      ▼  fetch to a temp file
FFprobe ─────────────► duration, display dimensions (rotation applied), fps
      │
      ▼  adaptive frame budget: 6 / 8 / 12 / 16 by duration, hard cap 16
timestamp plan ──────► midpoint rule, head/tail trimmed
      │
      ▼  one ffmpeg seek per timestamp, downscaled to <=768 px long edge
frames on disk (temporary)
      │
      ▼  dHash 9x8 grayscale, Hamming distance vs last KEPT frame
de-duplicated frames
      │
      ▼  VisionProvider.analyze()
model response ──────► Zod validation against taxonomy v2 ──► one repair retry
      │
      ▼
features + 110-dim vector ──► single Postgres transaction ──► status = analyzed
      │
      ▼
temp frames deleted
```

The frames exist only between extraction and the model call. They are analysis
artefacts, not stored media: the sole frame kept permanently is the poster written
at ingestion.

### Why sampled frames, not the whole video

A vision model bills for pixels. The corpus averages ~33 s at ~30 fps, so a full
decode is ~1,000 frames per video; the pipeline sends **7.5 on average**. That is
the difference between a plausible pipeline and an impossible one at 100k videos.

The sampling is adaptive rather than fixed because a 6-second clip and a
100-second one do not carry the same amount of distinct content. Tiering by
duration and then removing near-duplicates spends the budget where there is
actually something new to see. On this corpus, 219 candidate frames became 212
after de-duplication — near-duplicates are rare in short-form video precisely
because it is edited tightly, which is itself a useful finding: the de-duplication
step earns its place mainly as insurance against static or slideshow content, where
it collapses a video to the `MIN_ANALYSIS_FRAMES` floor.

Scene-aware sampling is implemented but **off by default**, because detecting cuts
requires decoding every frame — exactly the cost this design exists to avoid.

### The VisionProvider abstraction

```ts
interface VisionProvider {
  readonly name: string;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly synthetic: boolean;
  analyze(input: VideoAnalysisInput): Promise<VisionAnalysis>;
}
```

The contract says nothing about HTTP, message formats, base64 or tokens. It takes
sampled frames and returns validated features. A local ONNX runtime or a gRPC
service would be a sibling of the HTTP adapter, not a rewrite of the interface.

That matters because the model choice is deliberately deferred to a benchmark. The
`OpenAICompatibleProvider` covers Ollama, llama.cpp, vLLM, LM Studio and hosted
endpoints, so comparing two candidates is two `.env` values, not two integrations.

### Mock versus real

| | `MockVisionProvider` | `OpenAICompatibleProvider` |
|---|---|---|
| Sees the video | **No** — hashes the video id | Yes |
| `synthetic` | `true` | `false` |
| Purpose | Tests, offline development, unblocking downstream milestones | Actual analysis |
| Token usage | Always `null` | Whatever the backend reports |

The mock is honest about being fake: every CLI surface prints a banner, the model
version is `synthetic-archetype-v1`, and captions are prefixed
`[SYNTHETIC - not real analysis]`. It reports `null` tokens rather than plausible
ones, because fabricated counts would silently corrupt the cost model.

It assigns each video to one of six coherent archetypes rather than emitting
uniform noise. Random tags would produce a corpus with no cluster structure, and a
recommender demo over that shows nothing. It does **not** read the gold labels —
seeding from ground truth would make the benchmark measure itself.

### Structured output and validation

The prompt is generated from the taxonomy, so the allowed vocabulary can never
drift from what Zod enforces. Where the backend supports schema-constrained
decoding (`response_format: json_schema`) it is used; when a backend rejects it —
Ollama does — the provider downgrades **once** for the whole run and relies on
prompt-enforced JSON plus validation.

Validation is the actual guarantee, not constrained decoding:

1. Response text → strip markdown fences / surrounding prose → `JSON.parse`.
2. `videoFeaturesSchema.safeParse` — every categorical value must be in the closed
   vocabulary.
3. On failure, **one** repair retry with the exact validation errors fed back.
4. Still invalid → the video is marked `failed` with a classified reason.

The retry is bounded on purpose. A model that cannot follow the schema will not
learn to on the fifth attempt; it will just burn GPU time and hide the problem.

Errors are classified as `transport`, `timeout`, `invalid_json`,
`schema_validation`, `model_error` or `no_frames`, recorded on the video row as
`[kind] message`, and summarised per run. That turns "12 failed" into "11 timeouts
and one schema failure", which point at completely different fixes.

### Embedding

`encodeFeatures()` turns validated taxonomy output into the 110-dimension content
vector described above — confidence-weighted, `unknown` encoded as zero, L2
normalised. Features and vector are written in **one transaction**: a features row
without a vector is invisible to candidate generation, which would surface later as
a ranking bug rather than a missing write.

### Failure handling

| Failure | Behaviour |
|---|---|
| ffprobe cannot read the video | Rejected at ingestion, never reaches analysis |
| A single frame fails to extract | Skipped; the remaining frames proceed |
| Frame hash unavailable | Frame dropped — it cannot participate in de-duplication |
| Model returns invalid JSON or bad values | One repair retry, then `failed` with the reason |
| Model server down or slow | Classified `transport`/`timeout`; BullMQ retries with backoff |
| Preprocessing yields zero frames | `failed` with `no_frames` |

A failed video never blocks the queue, and its diagnosis is queryable in SQL rather
than only present in worker logs.

### Local versus rented inference

Measured on the development machine — RTX 2060, 6 GB, Qwen2.5-VL 3B at 4-bit,
`ANALYSIS_CONCURRENCY=1`:

| Measurement | Value |
|---|---|
| Model resident in VRAM | 3.4 GB (Ollama, 100% GPU offload, 16,384 context) |
| Total GPU memory in use | ~5.3 GB of 6.1 GB (desktop baseline ~0.65 GB) |
| Latency per video, gold-15 subset | mean 8.07 s, p50 5.22 s, p95 17.13 s |
| Latency per video, full-corpus-30 | mean 11.07 s, p50 12.60 s, p95 17.13 s |
| Frames per video | 7.5 mean |
| Tokens per video | ~9,200 in / ~415 out |
| Tokens per frame | ~1,230 at 768 px long edge |

Two constraints surfaced that are worth recording, because both are invisible until
you try:

**Context window, not just weights.** Ollama defaults this model to 4,096 tokens.
Six frames already measured 7,655 — the first real run failed with
`exceed_context_size_error`. The fix is a Modelfile raising `num_ctx` to 16,384,
which is committed at `ollama/Modelfile.qwen2.5vl-3b-16k`. This couples the frame
budget to the model's context: `MAX_ANALYSIS_FRAMES=16` needs roughly 20k tokens.

**KV cache is the real VRAM consumer.** Weights are 3.2 GB; the 16k context pushes
resident usage to ~4.7 GB. On a 6 GB card that leaves no room for a second
concurrent inference, which is why `ANALYSIS_CONCURRENCY` defaults to 1.

Moving to a rented A10/L4 (24 GB) changes no code — stand up any OpenAI-compatible
server and repoint `VISION_BASE_URL`. It buys headroom for a larger model, a longer
context and concurrency 2–4.

Hosted APIs are a third option with a caveat that outweighs price: a
general-purpose provider may refuse explicit adult content outright. Provider policy
has to be checked before hosted inference is an option at all.

### Benchmark conclusions

Qwen2.5-VL 3B (4-bit) against 15 hand-reviewed videos. Full report in
[docs/BENCHMARK.md](docs/BENCHMARK.md); the honest summary:

| Metric | Value |
|---|---|
| Macro score, all fields | **0.399** |
| Single-value fields | 0.383 |
| Multi-value fields | 0.485 |
| Schema validation failures | **0 / 30** |
| Inference failures | 0 |

**Structured output is solved; content understanding is not.** Zero schema failures
across the whole corpus means the closed taxonomy, generated JSON schema and repair
loop work — the model always answers in the vocabulary. Whether the answer is
*right* is a different question, and at 0.40 macro this model is not good enough to
ship on.

The error distribution is not random, which makes it useful:

| Confusion | Count | Reading |
|---|---|---|
| `performerGender`: mixed → female | 14/15 | |
| `performerCount`: duo → solo | 11/15 | |
| `cameraStyle`: pov → standard | 9/15 | |
| `explicitness`: explicit → suggestive | 8/15 | |
| `productionQuality`: amateur → semi_pro | 7/15 | |

The top three are **one failure, not three.** In POV footage the second performer
is mostly off-frame, so the model reports one visible woman, no second person, and
ordinary framing. Everything follows from not recognising the POV convention.

And it is an *instruction-following* failure rather than a perception failure. The
free-text caption for `video_01` reads "a woman... pulling out a man's cock and
starting to suck it" — the model plainly saw two people, described them, and then
set `performerCount: solo`. The information reaches the caption and not the
structured field. That is a promising thing to be wrong about: it suggests a
stronger model, or field descriptions that push harder on "count everyone visible
at any point", rather than a fundamental limit.

**Where the unknown split earned its place.** `adultAgeGroup` scores 0.67 strict but
**0.00 informative**: the model answered `unknown` on all 15 videos, and the
reviewer did so on 10. Every point of that 0.67 comes from agreeing about ignorance.
A single averaged metric would have ranked it a mid-table field; the split shows it
never once produced a usable answer. `penisSize` (predicted unknown 14/15, gold
4/15) and `hairColor` (10 vs 5) show the same over-caution more mildly.

Fields the model genuinely handles: `mediaType` (1.00 — animated vs live action is
unambiguous), `appearanceFeatures` (0.83, precision 1.00 — it never invents tattoos,
though it misses two thirds of them), `setting` (0.67).

**Conclusion for model choice.** This 3B model is a working integration and a
failing classifier. The taxonomy, prompt, validation and benchmark are all sound —
they are what makes the weakness measurable.

### Second model: Qwen3-VL-8B-FP8 on rented hardware

Same taxonomy, same prompt, same sampler, same 15 videos, same metrics — only the
model and the GPU changed. Full comparison in
[docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md).

**Model quality** — comparable, since both models saw identical frames and prompt:

| Metric | Qwen2.5-VL 3B | Qwen3-VL 8B FP8 |
|---|---|---|
| Macro, all fields | 0.399 | **0.549** |
| Macro, single / multi | 0.383 / 0.485 | **0.517 / 0.722** |
| Input tokens per frame | 1,230 | **528** |
| Schema failures | 0 | 0 |

**Deployment performance** — NOT a model comparison. The model and the GPU and the
serving stack all changed together, so none of these differences can be attributed
to model architecture alone:

| Metric | 3B on RTX 2060 + Ollama | 8B FP8 on RTX 4090 + vLLM |
|---|---|---|
| Latency, gold-15 (mean / p50 / p95) | 8.07 / 5.22 / 17.13 s | 9.57 / 9.35 / **11.06** s |
| Latency, full-corpus-30 (mean / p95) | 11.07 / 17.13 s | **9.49 / 10.5** s |
| VRAM observed | ~4.7 of 6.1 GB | 18.1 of 24.5 GB |

Both latency rows use the same provenance for both models — each model's
full-corpus-30 run, with gold-15 being that run filtered to the gold ids.

Note the mean latency **flips between samples**: on the 15 gold videos the 3B
deployment was faster on average (8.1 s vs 9.7 s), on all 30 it was slower
(11.1 s vs 9.5 s). The 3B's per-video times ranged 4.5–21.0 s while the 8B stayed
within 8.7–11.2 s, so the 3B's mean is unstable across subsets and its p95 is
half again as long. Predictability, not average speed, is the real difference.

Qwen3-VL uses **~57% fewer visual/input tokens per frame**, which shrinks context
size and inference workload. For a self-hosted deployment that is not a direct
cost saving — self-hosted cost is GPU time × hourly rate — but it is what allows a
larger model to fit the same frame budget in a smaller context window.

The 3B's dominant failure is largely fixed: `performerCount` 0.13 → 0.73,
`fetishTags` 0.13 → 0.70, `performerGender` 0.07 → 0.40. `hairColor` shows the
unknown split earning its place again — strict 0.27 → 0.53 looks moderate, but the
informative score goes 0.10 → **0.80** because the 8B stops answering `unknown`.

Two honest caveats, both left uncorrected on purpose:

- **`clothing` regressed 0.27 → 0.07.** The 8B under-calls nudity and escapes into
  `other`, a value the reviewer never used. It is not failing to perceive — its
  `explicitness` simultaneously doubled to 0.80 — it hedges on that one field.
  The prompt has **not** been tuned to fix this: adjusting it against these same 15
  videos would contaminate every future comparison with overfitting to the gold set.
- **`adultAgeGroup`: informative accuracy = 0 for both tested models.** Neither has
  produced a correct age band on a video where the reviewer committed to one. The
  field stays in taxonomy v2 as-is; it is a **candidate for redesign or removal in
  taxonomy v3**, not something to change mid-benchmark.

### Third model: InternVL3-8B (BF16), and why coverage is now reported

A third model from an unrelated family was benchmarked so the choice does not rest
on one lineage. `OpenGVLab/InternVL3-8B`, unquantized BF16, served by the same
vLLM 0.11.0 on the same RTX 4090.

It is the only one of the three that **failed to produce valid taxonomy output at
all** — twice out of fifteen, emitting values outside the closed vocabulary on both
attempts. That makes a single macro number misleading, so three figures are reported
together:

| Metric | Qwen2.5-VL 3B | **Qwen3-VL 8B FP8** | InternVL3 8B BF16 |
|---|---:|---:|---:|
| Coverage (valid output) | 15/15 = 100% | 15/15 = **100%** | 13/15 = 86.7% |
| Macro, valid output only | 0.399 | **0.549** | 0.420 |
| Macro single / multi (valid only) | 0.383 / 0.485 | **0.517 / 0.722** | 0.380 / 0.632 |
| **Macro, end-to-end** | 0.399 | **0.549** | 0.364 |
| End-to-end single / multi | 0.383 / 0.485 | **0.517 / 0.722** | 0.329 / 0.548 |
| Input tokens per frame | 1,230 | **528** | 971 |
| Schema failures | 0 | **0** | 2 |

**End-to-end** scores a video the model could not answer as 0 on every field, which
is what a pipeline actually experiences: an unanalysed video has no features and
cannot be recommended. Valid-only and end-to-end coincide exactly when coverage is
100%, which is why the two Qwen columns repeat. Comparing valid-only scores across
models with different coverage would reward the model that refused more videos.

Both are computed by `summarize()` from the same per-video results — the failure
penalty is a denominator, not an adjustment applied afterwards.

InternVL3's errors are systematic rather than scattered, and they fall on exactly
the fields the recommender depends on:

```
12x  performerGender:  mixed    -> female
 9x  performerCount:   duo      -> solo
 6x  penetrationType:  vaginal  -> none
 6x  explicitness:     explicit -> nudity
```

It describes only the female performer and under-states explicit activity;
`performerGender` scored **0.00**. Candidate generation leans on performer
composition and act semantics, so a model wrong in this particular direction
degrades recommendations more than its macro score suggests — and confidence
weighting cannot rescue a value that is confidently wrong.

One result points forward rather than back: `clothing` scores 0.27 / **0.07** /
0.31 across 3B / 8B / InternVL3. A weaker model scoring 4x higher than the selected
one on the same frames means the 8B's collapse is **not** explained by the corpus or
the sampled frames. It is a prompt/semantic problem, and a tractable one. Prompt v2
is still deliberately unchanged — see M8.5 below.

### A benchmark bug this comparison exposed

The first InternVL3 run reported **macro 0.446 over 15/15 videos**. That number was
wrong and is not used anywhere.

`bench-vlm --no-persist` runs a challenger without writing to the database, so the
incumbent's corpus survives. But scoring still fell back to the database row when a
prediction was missing:

```ts
const features = predictions.get(item.videoId) ?? row?.features;
```

On the two videos where InternVL3 failed validation there was no in-memory
prediction, so the fallback silently supplied **Qwen3-VL's stored features** and
scored them as the challenger's. The incumbent was inflating the challenger's score,
and precisely on the videos where the challenger was at its worst.

Fixed: under `--no-persist` (and `--load-predictions`) the database is never
consulted. A missing prediction stays missing, coverage drops, and the report prints
the real sample size (`videos scored 13/15`, `sample: 13 of gold-15`) instead of
implying a full run.

The general lesson is worth more than the fix: **a benchmark that can silently
substitute one model's output for another's will always fail in the direction that
hides the problem.** Any evaluation harness sharing storage with production data
needs this checked explicitly.

### M4 status

**M4 — VLM analysis and model selection: DONE.**

Selected model: **`Qwen/Qwen3-VL-8B-Instruct-FP8`**, served by vLLM, 100% coverage
on both the gold set and the 30-video corpus.

```
macro all     0.549
macro single  0.517
macro multi   0.722
```

0.549 is a sufficient baseline for the MVP, not a quality ceiling. The recommender
is built to tolerate imperfect features — they are confidence-weighted, `unknown`
contributes nothing to the content vector, and candidate generation is multi-source
so no single signal has to be right.

**The 15 labelled videos are a development set, not an independent measure.** They
have now been used to compare three models, analyse errors and reason about the
prompt, so any number quoted against them is a *fitted* number. They are called
**DEV-15** from here on; the remaining 15 videos are reserved as **HOLDOUT-15**, to
be labelled later and opened exactly once, after the configuration is frozen. That
is the only figure that can be presented as an independent quality claim.

Planned improvements are scoped as **M8.4 / M8.5 / M8.6** — held-out set
preparation, a controlled ablation, and a single final held-out evaluation — all
after the end-to-end MVP and none of them blocking it. Full plan, experiment
protocol and stop rules in [docs/ROADMAP.md](docs/ROADMAP.md).

The ordering is deliberate: **VLM tag macro is not recommendation quality.** The
product is judged as video → features → profile → candidates → ranking → diversity
→ feed, so a working feed on a 0.549 tagger is worth more than a better tagger with
no feed.

### Cost conclusions

Full model in [docs/COST_MODEL.md](docs/COST_MODEL.md), regenerated from measured
data by `npm run cost-model`.

The current model uses the **full-corpus-30 measured mean of 9.5 s/video** on the
rented RTX 4090 — 100k videos is ~264 GPU-hours, or 10,827 RUB at the invoiced
41.06 RUB/hour. The full-corpus mean is used rather than the gold-15 mean because
the 30-video sample spans the corpus's actual duration distribution, and duration
drives the frame budget that drives inference time.

What matters more than the figure is the shape:

- **GPU inference dominates.** Preprocessing is ~22 core-hours — two orders of
  magnitude cheaper. That gap is the entire justification for adaptive sampling:
  it moves work from the expensive tier to the cheap one.
- **Frames are the lever.** Cost is linear in frames and quadratic in frame edge
  length. Dropping `FRAME_MAX_LONG_EDGE` from 768 to 512 would cut tokens per frame
  by ~55%.
- **Sending whole videos is not a near-miss, it is ~140x more expensive** on this
  corpus. That is the number that settles the "why not just send the video" question.
- **Storage is small but recurring**, so on a long horizon it overtakes the one-off
  inference cost.

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

## Serving 3,000 requests per second

The target is 3k RPS on the feed endpoint with a corpus of ~1M videos. What follows
is arithmetic, not a box diagram: the point is to show which numbers are
comfortable, which are tight, and which are the actual constraint.

### Assumptions

Every number below follows from these. They are estimates, not measurements — the
MVP has three demo users, so nothing here has been load-tested. What is being shown
is the shape of the arithmetic and which quantity binds first.

| # | Assumption | Value | Basis |
|---|---|---|---|
| A1 | Feed endpoint traffic | 3,000 req/s | Given in the brief |
| A2 | Items returned per request | 10 | One screen of a vertical feed |
| A3 | Payload per item | ~200 B | id, media URL, poster URL, duration, top tags |
| A4 | Registered users | 1,000,000 | "Ожидается миллион роликов"; users assumed same order |
| A5 | Daily active users | 300,000 | 30% of registered — typical for a consumer feed app |
| A6 | Concurrent active users at peak | 30,000 | 10% of DAU online at once |
| A7 | Session length | 20 min | Short-form feed session |
| A8 | Requests per user per minute while scrolling | 6 | One page of 10 items every 10 s |
| A9 | Feed list size | 50 items (`FEED_SIZE`) | Config |
| A10 | Refill watermark | 10 items (`FEED_REFILL_WATERMARK`) | Config |
| A11 | Feed TTL | 3,600 s (`FEED_TTL_SECONDS`) | Config |

Note A6 and A1 are consistent: 30,000 concurrent users × 6 req/min ÷ 60 = **3,000
req/s**. That is where the brief's number comes from in this model, rather than
being assumed independently.

### What a request costs

`GET /feed` is a Redis `LRANGE` on a precomputed list plus one batched hydration
read for the items it returns. Nothing else. No Postgres, no pgvector, no ranking.

| Quantity | Formula | Result |
|---|---|---|
| Response size | A2 × A3 = 10 × 200 B | ~2 KB |
| Application egress | A1 × 2 KB = 3,000 × 2 KB | **6 MB/s** |
| Redis ops per request | 1 `LRANGE` + 1 `MGET` | 2 |
| Redis ops/s | A1 × 2 = 3,000 × 2 | **6,000 ops/s** |

6 MB/s is ~48 Mbit/s of JSON — trivial. The 6,000 ops/s is roughly **6% of a single
Redis node**, which sustains 100k+ simple ops/s.

### Where the headroom is

**Redis is not the constraint.** 6,000 ops/s is ~6% of one node. Redis is
replicated for availability, not throughput. Memory: `A4 × A9 × 40 B` =
1,000,000 × 50 × 40 B ≈ **2 GB** of feed lists, plus a hydration cache of the hot
video payloads (100k videos × 200 B ≈ 20 MB). One instance holds it comfortably;
Redis Cluster is only needed if the keyspace grows an order of magnitude.

Storing feeds only for *active* users (A5) instead of all registered users drops
this to ~600 MB, which is the natural first optimisation if memory ever matters.

**Fastify is not the constraint either, but it sets the pod count.** A Node process
serving small JSON responses sustains on the order of 8–12k RPS per core in
published benchmarks; assume **3–4k RPS per pod** after real-world overhead (TLS
termination upstream, logging, metrics). `3,000 ÷ 3,500 ≈ 1` pod to carry the load,
so **3–4 pods** for redundancy and rolling deploys, **6–10** if the headroom target
is 2–3× peak. Pods are stateless, so this scales linearly.

**Postgres sees almost no read traffic from the feed.** It is written to by event
workers and read by feed builders, both off the request path.

**The real constraint is video bytes, and it never touches the application.**
`A6 × 3 Mbps` = 30,000 concurrent viewers × 3 Mbps ≈ **90 Gbps** of media egress —
four orders of magnitude more than the 48 Mbit/s of JSON the API serves. No Node
process can or should carry that: clients receive CDN URLs and fetch from edge
nodes. This is why `videos.s3Key` is presigned rather than proxied, from the first
milestone onward.

This is the single most important number in the document. Media delivery dominates
everything else by so much that the entire application tier is a rounding error
against it — which is exactly why the architecture keeps bytes out of the app.

### The number that actually needs watching

Feed generation throughput is **not** a function of request RPS, and it is the
quantity that decides the cluster size. It has three independent drivers, which
have to be added rather than guessed at:

| Driver | Formula | Result |
|---|---|---|
| **Consumption** — a scrolling user exhausts their list and trips the watermark | A6 × A8 ÷ (A9 − A10) = 30,000 × 6 ÷ 40 | **75 refills/s** |
| **TTL expiry** — idle cached feeds expiring across the whole user base | A5 ÷ A11 = 300,000 ÷ 3,600 | **83 rebuilds/s** |
| **Interaction-triggered** — debounced profile updates, ~1 rebuild per 20 events | A6 × A8 ÷ 20 = 30,000 × 6 ÷ 20 | **150 rebuilds/s** |
| **Total at peak** | 75 + 83 + 150 | **~310 rebuilds/s** |

A previous draft of this document asserted "~1k rebuilds/s" with no derivation. It
was wrong: it implicitly assumed all 1M registered users were simultaneously active
and rebuilding on the TTL, which double-counts inactive users. The corrected figure
is **~310/s at peak**, roughly a third of that.

Sizing follows:

| Quantity | Formula | Result |
|---|---|---|
| Work per rebuild | 5 candidate queries + HNSW kNN + rank + diversity | 20–50 ms (estimate) |
| CPU-seconds per second | 310 × 0.035 s (midpoint) | **~11** |
| Workers at 70% utilisation | 11 ÷ 0.7 | **~16 workers** |

So the recommendation tier is order **15–25 workers**, not 50. It remains the
largest compute line item, and it is the number to instrument first, because the
20–50 ms estimate is the least trustworthy input here.

Levers, in the order they should be pulled:
1. **Rebuild on a budget, not on every event.** The interaction driver is the
   largest of the three; widening the debounce window from 20 events to 50 removes
   ~90 rebuilds/s on its own.
2. **Rebuild lazily for inactive users.** The TTL driver assumes every DAU's feed
   is regenerated on expiry. Regenerating on next open instead removes most of the
   83/s, at the cost of a slower first request.
3. **Shard candidate generation by user id** — embarrassingly parallel.
4. **Cap kNN cost with HNSW `ef_search`**, trading a little recall for latency.

### Failure modes

| Failure | Behaviour | Why it is survivable |
|---|---|---|
| Redis lost entirely | Feeds and queues gone; API returns trending from a rebuilt global list | Feeds are a cache, derivable from Postgres. Queue state is AOF-persisted |
| Cold cache after deploy | Every request misses | Global trending feed is a single precomputed key — one Redis read, no stampede into pgvector |
| Postgres down | Serving continues from Redis; no rebuilds, no ingestion | The hot path never reads Postgres, so an outage degrades freshness rather than availability |
| VLM offline | Analysis jobs accumulate in BullMQ; existing corpus serves normally | Ingestion and analysis are decoupled queues |
| One recommendation worker crashes | BullMQ redelivers the job | Rebuilds are idempotent — a feed is overwritten, never appended |
| pgvector index degraded | Candidate generation loses the `similar` source | Four other sources still return candidates; the feed gets worse, not empty |

That last row is the reason candidate generation is multi-source. It is not only
about recommendation quality — it is the difference between a degraded feed and no
feed.

### What changes from the MVP

The MVP already has the right shape: precomputed feeds, stateless API, queues for
heavy work, bytes served from object storage. Reaching 3k RPS is mostly operational
rather than architectural.

| Component | MVP | At 3k RPS |
|---|---|---|
| API | One Fastify process | 6–10 stateless pods behind a load balancer |
| Feed cache | Single Redis | Redis with replicas; cluster only if the keyspace outgrows one node |
| Queues | BullMQ on the same Redis | Separate Redis for queues, or Kafka/Redpanda if event volume justifies it |
| Events | Written straight to Postgres | Buffered through a stream; ClickHouse for behavioural analytics |
| Video delivery | Presigned MinIO URLs | CDN in front of object storage, multi-bitrate HLS |
| Analysis | One worker, one GPU | Autoscaled GPU pool sized by queue depth |
| Recommendation | Inline with the event worker | 20–50 dedicated workers, sharded by user id |
| Orchestration | Docker Compose | Kubernetes with HPA on queue depth and CPU |

Kafka, ClickHouse, Redis Cluster and Kubernetes are deliberately **not** in the MVP.
Each solves a problem that a 30-video corpus and three demo users do not have, and
adding them early would obscure the recommendation logic that this project is
actually about.

---

*Sections still to come: ingestion, video analysis and adaptive sampling, the
two-stage recommender, database model, cost estimation for 100k videos, tradeoffs,
future improvements.*
