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
| Prepared feeds in Redis (`feed:gen:{userId}:{feedId}`) | Ranked and ordered using old-space similarity, and may reference videos that went back to `ingested` |

**Rule: a taxonomy version change invalidates every prepared feed.** After steps
1–4, profiles are rebuilt from the event log and every cached feed is dropped and
regenerated — a feed is a cache of a ranking decision, and that decision was made
in a space that no longer exists. Serving one after a taxonomy change would show
users a feed ordered by a similarity metric the system can no longer reproduce or
explain.

No extra Redis machinery is needed for this. Bumping each affected user's feed
epoch drops the active pointer and queues a rebuild through the same path an
interaction uses (see "Serving the feed"), so the migration invalidates and the
normal build path repopulates. The ordering constraint is recorded here because it
is a property of the migration, not of the cache.

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

## User interactions and the preference profile

The bridge between "we have described the videos" and "we can rank them for this
person". Implemented in [src/reco/](src/reco/).

### From behaviour to a number

```
user interaction -> signed weight -> time decay -> x video vector -> profile
```

Event weights live in exactly one module, `src/reco/signals.ts`:

| Event | Weight | Meaning |
|---|---:|---|
| `impression` | 0.00 | Shown, not chosen. Exposure, not interest. |
| `view` | +0.25 | Started or continued watching. |
| `watch` | +0.25 | **Legacy, not accepted by the API** — see below. |
| `complete` | +0.60 | Watched to the end. |
| `like` | +1.00 | Explicit approval. |
| `skip` | −0.50 | Dismissed quickly. |
| `dislike` | −1.00 | Explicit rejection. |

They are constants rather than environment variables deliberately: six knobs
nobody will turn during a one-week MVP add deployment surface without adding
capability. The two values that genuinely are policy — the decay half-life and the
cold-start threshold — already exist in config as `PROFILE_HALFLIFE_DAYS` (7) and
`COLD_START_MIN_INTERACTIONS` (5).

**One canonical signal per meaning.** The original schema shipped both `view` and
`watch`, which mean the same thing. Two accepted event types with the same meaning
are additive by accident: a client emitting `view` on playback start and `watch` as
a progress ping would contribute +0.50 for a single playback — double what the
table promises, and nearly as much as finishing the video. `watch` therefore has no
producer and is rejected by the intake schema; it keeps its weight only so any row
written against the original enum still scores. Watch *duration* is carried by
`positionPct` on the event, not by a separate event type.

### The formula

```
signal_i = eventWeight(type_i) x decay(age_i)

decay(ageDays) = 0.5 ^ (ageDays / halfLifeDays)

              sum( signal_i x v_i )
profile P =  ------------------------
              max( sum |signal_i|, eps )
```

where `v_i` is the video's 110-dimension taxonomy vector.

**Why exponential decay.** Linear decay has a cliff — an event one day outside the
window is worth nothing while one just inside it is worth something — and taste
fades rather than expiring. Exponential decay is also self-limiting: old events
never quite reach zero but stop mattering, so the profile keeps a faint long-term
memory while tracking recent behaviour. With a 7-day half-life: today 1.0, a week
ago 0.5, two weeks ago 0.25.

**Why divide by the sum of absolute signals.** Without it the vector's magnitude
grows with activity, so a heavy user and a light user with identical taste would
produce different-length vectors and any threshold tuned on one would be wrong for
the other. Dividing by total signal mass makes the profile a weighted *average* of
the content the user reacted to. Repeating the same interaction then reinforces a
preference instead of inflating it.

Absolute value, not the signed sum: a user with one like and one skip has a signal
mass of 1.5, not 0.5. A signed denominator could approach zero for a balanced user
and blow the vector up.

**Why negative dimensions survive.** Values are left negative rather than clamped
at zero. A profile that can only accumulate positives drifts toward whatever it has
already been shown and cannot recover from a bad recommendation streak, because
nothing pushes a preference back down. M6 reads negative dimensions as active
dislikes rather than as absence of evidence.

The whole thing is deterministic and interpretable — no model, no training.
Rebuilding from the same history always produces the same vector, which is what
makes the "why was this recommended" panel trustworthy rather than decorative.

### Videos without features

An interaction with a video that has no analysed taxonomy vector is stored as
behaviour but contributes nothing to the profile, and is counted separately in
`skipped_no_features`. Substituting mock features there would teach the profile
preferences the user never expressed — the same class of mistake as the benchmark
contamination found in M4.

### Cold start

Cold start is decided by `effective_signal_count`: events with a non-zero weight
*and* an analysed video behind them. Below 5, the user is cold. Scrolling past
fifty videos generates fifty impressions and leaves the user exactly as cold as
they started, which is correct — being shown things is not the same as liking them.

M5 only sets the flag. What a cold user actually sees is M6/M7.

### Creator affinity, kept outside the vector

```
creatorAffinity(c) = sum( signal_i for creator c ) / max( sum |signal_i|, eps )
```

Same denominator as the profile, so the two are on the same scale and the value
can be negative — a creator the user reliably skips scores below zero.

Creators are deliberately **not** dimensions of the taxonomy vector. "Which
creators does this user like?" is an identity question, not a content one; putting
creators in the vector would force a schema migration and a full re-embed whenever
the creator set changed, and would let creator identity leak into content
similarity. It is stored in a normal table rather than a JSON blob because M6 needs
"top creators for this user" as an indexed query. It is a ranking feature there,
never a hard filter — a user who likes a creator should still see other creators.

### Storage

`user_profiles` holds the materialised vector plus the counters needed to diagnose
it (interaction count, effective signal count, positive and negative signal mass,
skipped-no-features, cold-start flag). M6 must be able to rank from one read rather
than replaying history per request.

Idempotency is enforced by a unique index on `events.event_id`, a client-supplied
key, rather than by a read-then-write check — two concurrent retries would both
pass a check and both insert. Mobile clients retry on flaky networks, and without
this a single like becomes two.

### MVP rebuild, and how it evolves

The MVP recomputes a user's profile from their full history on every write. For one
user that is a few milliseconds, it is exactly reproducible, and there is no
incremental state to drift out of sync. It does not scale to millions of users.

The production path keeps the formula and changes the plumbing:

```
interaction API -> Kafka / Redpanda -> profile updater (incremental)
                                    -> profile store: Redis + durable Postgres
```

The updater applies each event to a running sum rather than replaying history, with
periodic full rebuilds to correct drift and to re-encode after a taxonomy change.
Nothing in the formula above changes — which is the point of keeping
`computeProfile()` a pure function of (events, vectors, clock).

## Candidate generation, ranking and diversity

The recommendation core. Implemented in [src/reco/](src/reco/) as four modules —
`candidates.ts`, `ranking.ts`, `diversity.ts`, `recommender.ts` — because the three
stages fail differently and must be testable apart.

```
user profile
   → 5 candidate sources → union → dedupe → filter
   → feature computation → weighted ranking
   → diversity reranking
   → ordered list
```

It answers *which videos, in what order*. It does not serve them: turning this into
a feed is M7, and the 3k RPS design depends on no HTTP request ever reaching this
code.

### Five sources, independently capped

| Source | Cap | How it retrieves |
|---|---:|---|
| `similar` | `CAND_SIMILAR_K` 200 | pgvector cosine between the profile vector and video vectors |
| `tag` | `CAND_TAG_K` 100 | jsonb lookup on the user's strongest preferred taxonomy values, over the GIN index |
| `trending` | `CAND_TRENDING_K` 100 | signed engagement from `events` in a `TRENDING_WINDOW_HOURS` (72h) window |
| `fresh` | `CAND_FRESH_K` 50 | newest analysed videos |
| `explore` | `CAND_EXPLORE_K` 50 | deterministic hash of `userId + videoId + UTC day` |

No source filters, scores or orders — each returns a plain set of ids. Filtering and
ranking are common stages that run once over the merged set, so an exclusion rule is
written once instead of five times, and one source returning nothing cannot starve
the feed. A video found by several sources appears **once**, carrying every source
that produced it (`sources: ["similar","tag","fresh"]`) — which is what makes the
demo able to say where a recommendation came from.

`similar` and `tag` overlap without being redundant: the vector generalises to tag
combinations the user has never seen, the tag lookup is exact, explainable, and
still works if the vector index is unavailable.

**Eligibility** is one rule: `status = analyzed`, a stored taxonomy vector of the
current version and dimension, all values finite. That covers ingested, analysing
and failed in a single condition, which is why no separate `unavailable` status
exists. Mock features are never substituted for missing ones — that would recommend
a video on invented content.

**Seen** means *distinct videos with any event*: an impression, a view and a like of
one video are one seen item, not three. When fewer unseen candidates exist than were
requested, the result reports `candidateShortage` rather than quietly padding the
list with already-seen videos. Whether to re-show them is a product policy question,
and it belongs to M7.

### Ranking

```
score = W_AFFINITY(1.0)          × affinity
      + W_QUALITY(0.15)          × quality
      + W_FRESHNESS(0.2)         × freshness
      + W_POPULARITY(0.25)       × popularity
      − W_FATIGUE(0.35)          × fatigue
      + W_EXPLORATION(0.1)       × exploration
      + W_CREATOR_AFFINITY(0.2)  × creatorAffinity
```

| Feature | Range | Meaning |
|---|---|---|
| `contentSimilarity` | [−1, 1] | cosine(profile, video). Negative = matches active dislikes |
| `tagAffinity` | [−1, 1] | mean signed preference over the video's meaningful tags |
| `affinity` | [−1, 1] | `(contentSimilarity + tagAffinity) / 2` |
| `creatorAffinity` | signed | from `user_creator_affinity`; 0 when the creator is unknown |
| `popularity` | [0, 1] | engagement scaled against the strongest in the trending window |
| `freshness` | [0, 1] | `0.5 ^ (ageHours / 168)` |
| `fatigue` | [0, 1] | repetitiveness vs recent history; **subtracted** |
| `exploration` | [0, 1] | deterministic hash |
| `quality` | [0, 1] | `aestheticScore`; 0 with `qualityAvailable: false` when absent |

> **Initial ranking weights are heuristic priors because no production interaction
> dataset exists yet.** They encode an opinion about what should matter, and they
> are honest about being an opinion. A learned ranker is planned separately as
> M8.7; this stage's interface is what makes that a drop-in replacement.

Two similarity signals are kept and averaged rather than collapsed: cosine is a
geometric summary of all 110 dimensions, tag affinity is a per-tag match that can be
read aloud. Both are stored in the breakdown, so a future learned ranker can weight
them separately instead of inheriting an arbitrary 50/50.

**Popularity is normalised over the whole trending window, not over the caller's
candidate pool.** `loadEngagement` aggregates every event in the window across the
corpus with no user or candidate filter, so a video scores the same for every user
at every requested limit — otherwise "popularity" would mean something different per
request and could not be reasoned about. Negative engagement clamps to zero rather
than being rescaled: min-max over signed values has a nasty failure mode where, in a
window that is net-negative, the *least* skipped video maps to 1.0 and is presented
as the most popular thing in the catalogue.

**Quality is `aestheticScore`, not `productionQuality`.** Professional vs amateur is
a *kind* of content and plausibly a user preference; treating it as quality would
silently push every user toward studio material. `aestheticScore` is the model's own
0–1 judgement of visual appeal — still only a weak prior, since it is a self-report
never validated against the gold set, which is why it carries the smallest weight.
When it is missing the feature reports itself unavailable and contributes zero,
rather than inventing a proxy.

### Fatigue is not diversity

They are easy to conflate and they solve different problems.

- **Fatigue** looks *backwards* at history: how much of what this user has recently
  seen already looks like this candidate. Measured over recent **distinct videos**,
  not events, so three interactions with one video are one exposure.
- **Diversity** looks *sideways* within the list being built.

A feed can be internally diverse and still be the fifth day running of the same
creator; only fatigue catches that. Fatigue is scaled by how full the history window
is — a frequency measured over three videos is noise, and at full strength it would
outweigh every positive term.

### Cold start

`isColdStart` comes from M5 (fewer than 5 effective signals). For such a user the
`similar` and `tag` sources are skipped entirely, and `affinity` and
`creatorAffinity` are zeroed in ranking. A sparse profile is not a taste, and
pretending otherwise produces confident recommendations built on two clicks.

What remains is global: popularity, freshness, quality and exploration. What a
cold-start user is actually *shown* is M7's problem.

### Diversity reranking

A separate pass over the ranked list, never folded into the score.

```
rerankScore = baseScore − DIVERSITY_LAMBDA(0.3) × max(0, maxCosineToSelected)
```

Only positive similarity is penalised: a candidate that is the opposite of what is
already selected is the diverse choice, and rewarding it would turn diversity into a
second hidden ranking signal.

Two independent hard caps, because they fail differently — ten creators shooting
near-identical content, or one creator across genuinely varied content:

- `DIVERSITY_MAX_SAME_CREATOR` = 2. A **null creator is exempt, not pooled**:
  treating "unknown" as one shared creator would let anonymous videos block each
  other, the opposite of the rule's purpose.
- `DIVERSITY_MAX_SAME_TAG_IN_TOP10` = 3, applied in the top 10 where monotony is
  actually visible.

**Meaningful diversity tags** are a single centralised policy
(`diversityTags.ts`), shared by diversity and fatigue so "similar content" cannot
mean two different things in two files. It counts `actType`, `fetishTags`,
`setting`, `cameraStyle`, `hairColor`, `sexPosition`, `penetrationType`, and
excludes `unknown`, `none` and the near-constant fields — on this corpus almost
every video is `performerGender:female` and `explicitness:explicit`, so capping on
those would block the entire feed while telling the user nothing. It works through
taxonomy semantics, never through vector offsets, and a compile-time assertion fails
if a taxonomy change leaves a field unclassified.

**Small-corpus fallback.** Pass 1 honours every constraint; pass 2 runs only if the
list is still short and candidates remain, filling the rest by score with the caps
lifted and setting `diversityRelaxed` in diagnostics. On 30 videos the caps can
genuinely make a full list impossible, and returning four videos when ten exist is a
worse answer than a slightly repetitive ten. Note that requesting a limit close to
the corpus size forces relaxation by construction — the caps cannot hold when the
whole catalogue must be returned.

### Determinism

Ties break on `videoId`, exploration is a hash rather than `Math.random()`, and the
exploration bucket is the UTC day. The same user, database state and day therefore
produce the same list — which is what makes the output testable, debuggable and
explainable.

### Explainability

Every ranked candidate carries its sources, all nine feature values, each weighted
term, the base score, the diversity penalty and the final score. That is what
answers "why is this above that?" — for debugging now and for the demo panel later.
It is diagnostic output, not something a production client is handed by default.

### At scale

Measured on the current corpus: 30 videos, ~10 ms per user end to end (69 ms on the
first call, which includes connection warm-up). Nothing here needs optimising yet.

The shape that survives to a million videos:

```
profile
  → ANN (pgvector HNSW) + precomputed trending/fresh pools + creator/tag indices
  → a few hundred candidates
  → feature enrichment → rank → diversify
```

The similarity query is already expressed in pgvector rather than in JavaScript
precisely so the HNSW index takes over transparently: the semantics do not change,
so the recommendation logic does not either. Trending currently aggregates raw
events on read; at scale that becomes a streaming counter with periodic snapshots
into a precomputed pool. Neither is implemented now — a Kafka topic with no consumer
is architecture theatre.

## Serving the feed

### Hot path

```
GET /feed  →  Fastify  →  Redis  →  response
```

That is the whole request path. There is **no** code path from an HTTP request to
Postgres, pgvector or the ranker — not as a fallback, not behind a flag, not with a
timeout. It is enforced by what `src/feed/service.ts` imports rather than by
discipline: the module that answers requests cannot reach the recommender, and a
test makes the recommender throw to prove it stays that way.

### Cold path

```
cache miss / invalidation / refill
        ↓
    BullMQ job  (deduplicated on user + epoch)
        ↓
    feed worker      ← its own process: npm run worker:feed
        ↓
    recommendCandidates()   ← M6, the only caller
        ↓
    Redis generation + active pointer
```

### Redis model

| Key | Holds | TTL |
|---|---|---|
| `feed:{userId}:epoch` | integer, bumped on every state change | none |
| `feed:{userId}:active` | the feedId a new session starts on | `FEED_TTL_SECONDS` (3600) |
| `feed:gen:{userId}:{feedId}` | the generation, immutable once written | 2 × TTL |

**Generations are immutable.** A rebuild writes a new feedId and flips the pointer;
it never edits a published feed. That is what lets a cursor keep reading the list it
started on instead of having items shift underneath a scrolling client. The
generation outlives the pointer (2 × TTL, derived rather than a new config knob)
for the same reason: the pointer answers "what does a new session get?", the
generation answers "what is this session reading?".

Publishing writes the payload **then** moves the pointer. The reverse order would
briefly name a feed that does not exist, and every reader would see a miss and queue
another build.

The cached payload is deliberately thin — videoId, rank, creatorId, plus generation
metadata. No taxonomy vectors, no score breakdown, no captions: those live in
Postgres and in the recommender's diagnostics, and a cache exists to be read fast.
A 16-item generation serialises to about 1.5 KB.

### Epochs: why a slow build cannot overwrite a fast one

```
job A starts (epoch 1) → user likes something (epoch 2) → job B builds and publishes
                                                        → job A finishes last
```

Without a guard, A overwrites a fresh feed with a stale one. The worker re-reads the
epoch immediately before publishing and discards its result if it no longer matches.
A discarded build is a normal outcome, not a failure — the newer job already
published something better.

`INCR` is atomic, so two concurrent interactions cannot land on the same epoch, and
the epoch doubles as the deduplication key: a hundred simultaneous cache misses for
one user collapse into one logical build, while a genuine state change always gets
its own. Deduplication uses BullMQ's own `deduplication: { id, keepLastIfActive }`
rather than a hand-rolled lock or a `jobId` — verified against the installed 6.3.x,
where `jobId` dedupe stops working as soon as the completed job is evicted.

### Invalidation

```
POST /interactions → event persisted → profile rebuilt → INCR epoch → drop pointer → queue rebuild
```

| Event | Profile | Marks seen | Invalidates feed | Rebuild |
|---|---|---|---|---|
| `impression` | no change (weight 0) | **yes** | **no** | deferred to the next build |
| `view` | +0.25 | yes | yes | queued |
| `complete` | +0.60 | yes | yes | queued |
| `like` | +1.00 | yes | yes | queued |
| `skip` | −0.50 | yes | yes | queued |
| `dislike` | −1.00 | yes | yes | queued |
| *duplicate of any* | no change | no change | **no** | none |

**`impression` is the deliberate exception.** It is recorded, and it makes the video
seen for the *next* build — but it does not force one now. A client displaying ten
items sends ten impressions, and since the epoch is the deduplication key, ten
epochs means ten distinct builds: the mechanism that protects against a cache-miss
stampede cannot help, because each event legitimately creates a new key.

The trade is freshness against rebuild amplification, and it buys session stability
as well: a user scrolling a generation keeps reading it instead of having it
replaced underneath them by their own scrolling. The impression is not lost — the
next build, triggered by a real preference signal or by TTL, excludes the video.

A **duplicate** event invalidates nothing whatever its type: it changed no state, and
bumping the epoch again would discard a valid feed to rebuild an identical one.

The epoch bump and the pointer drop go in **one MULTI/EXEC**. Sent as two loose
commands, a connection drop between them would leave the epoch advanced while the
pointer survived - so `/feed` would keep serving a generation that predates the
interaction until the TTL expired an hour later.

The queue write is deliberately outside that transaction: Redis MULTI cannot span
BullMQ job bookkeeping, and making them atomic would need a distributed
transaction. Ordering is what makes it safe - invalidate first, then queue - so a
failed enqueue leaves a cache **miss**, which the next GET repairs by queueing the
build itself. The failure mode is a delayed rebuild, never a wrong feed. The
response reports `feedInvalidated` and `rebuildQueued` separately, because those
are two facts and one of them can be true without the other.

The interaction is the primary operation and the feed refresh is a side effect. If
Redis or the queue is down, the interaction stays committed in Postgres and the
failure is logged. Failing the write to protect a derived cache would lose user data
to preserve something rebuildable. Production closes that gap with a transactional
outbox; a queue write inside the database transaction would only move the problem.

### TTL and freshness are different mechanisms

- **TTL** bounds how long a feed may live if nothing happens. It is a backstop
  against indefinitely stale cache, not a freshness guarantee.
- **Invalidation** is what actually keeps feeds fresh, and it is immediate and
  event-driven.

A user who interacts gets a new feed in seconds regardless of TTL; a user who does
nothing for an hour gets a rebuild because the pointer expired.

### Refill

When a client comes within `FEED_REFILL_WATERMARK` (10) items of the end of a
generation, the next one is queued in the background. The request is always served
from the current generation — refill never blocks or changes what is returned.

Two guards stop it becoming a treadmill: it is deduplicated per generation, so
paging through the tail queues one build rather than one per request; and it is
skipped when the generation reported `candidateShortage` or is empty. Rebuilding
cannot invent videos that do not exist, so on a small or fully-seen corpus a refill
would rebuild the same short list forever.

### Cursor semantics

An opaque base64url cursor encoding version, userId, feedId and offset. Page numbers
would be wrong here: the feed can be rebuilt between requests, so "page 3" would
silently mean a different slice of a different list.

It is validated, not trusted — length-capped before decoding, version-checked, and
rejected outright if it names a different user. The Redis key is built from the
requesting user plus the feedId, so a cursor cannot address another user's feed or
inject an arbitrary key. It is not signed: the project has no secret to sign with,
everything it encodes is already known to the client, and validation catches what
signing would.

### What each response means

| Status | Meaning |
|---|---|
| `200` | Served from cache |
| `202` | No feed yet; a build was queued. The API did not compute anything |
| `400` | Bad request, or a malformed cursor / one belonging to another user |
| `404` | Unknown user |
| `410` | The cursor was valid but its generation has expired — start a new session |
| `503` | The feed cache is unavailable |

An **empty feed is a ready answer**, cached like any other. Treating it as a miss
would queue a build on every request forever.

**503 rather than a synchronous rebuild** is the important one. Computing feeds in
the API process during a Redis outage converts a cache failure into a database
stampede at the moment the system is least able to absorb one.

### Generation retention

TTL bounds how *old* a generation may be. It does not bound how *many* exist — a
user who interacts twenty times in two hours would hold twenty live payloads, and
any per-user memory estimate built on "one feed each" would be wrong by that factor.

At most **two generations per user** are retained: the current one and the one it
replaced. Kept in a per-user index list (`feed:{userId}:generations`, newest first)
so eviction reads that list instead of globbing the keyspace — `KEYS`/`SCAN` is O(n)
over the whole database and has no business near this code. TTL stays as a
secondary cleanup for abandoned users; it is no longer the only thing bounding
memory.

Two is the smallest number that keeps a cursor working across a refresh, which is
the case that matters: a client mid-scroll when a rebuild lands. A cursor into the
generation before that returns 410 and the client starts a new session. It is a
module constant rather than a config knob — a property of the caching strategy, not
something an operator tunes.

| After | Retained | An old cursor gets |
|---|---|---|
| 1st build | `[g1]` | — |
| 2nd build | `[g2, g1]` | `g1` still readable → 200 |
| 3rd build | `[g3, g2]` | `g1` evicted → 410 |

### Measured locally

30 videos, one process, in-process HTTP injection:

| | |
|---|---|
| Cache hit | mean 1.9 ms · p50 1.9 ms · p95 2.0 ms (50 requests) |
| Cold miss (enqueue only) | 2.7 ms |
| Background build (M6 + publish) | ~12 ms |
| Generation payload | 1,536 bytes for 16 items ≈ **96 B/item** |

**Memory, honestly bounded.** At the measured ~96 B per item, a full 50-item
generation is ~4.8 KB, and two retained generations per user is ~9.6 KB:

```
~1 GB payload-only lower-bound estimate for 100k users
at two retained 50-item generations; actual Redis memory is higher.
```

Higher because payloads are not the only thing stored: Redis per-key object
overhead, the active pointer, the epoch counter, the generation index, BullMQ's own
structures, and allocator fragmentation all add to it. How much is not guessed here
— it needs measuring against a populated instance, which this project has not done.

These figures say the hot path is a Redis read. They say nothing about 3k RPS,
which needs load testing that has not been done either.

### Future work, deliberately not implemented

Recorded so the design is not lost and so nothing above reads as already built.

**Trending fallback on a cache miss.** Earlier revisions of this document described
a miss being served from a **precomputed global trending feed** — degradation
instead of a 202. It is a better client experience, and it remains the natural next
step, but it is **not implemented in M7**: a miss answers `202 building`. Both
avoid the stampede, which is the property that matters; the trending feed
additionally avoids showing a new user an empty screen. `TRENDING_FEED_SIZE` and
`TRENDING_FEED_REFRESH_SECONDS` exist in config and are **reserved for this** — they
have no consumer in the current code, and are marked as such in `env.ts`.

**An operator rebuild lever.** `POST /admin/feeds/rebuild` and an
`npm run rebuild-feeds` command were previously listed here as if they existed.
They do not, and the npm entry has been removed rather than left to fail. Rebuilds
are triggered by interaction, cache miss and refill; nothing yet needs a manual one.

**Durable invalidation delivery.** Postgres interaction persistence and Redis feed
invalidation are not one distributed transaction. If Redis is unavailable after the
primary Postgres write, the interaction remains durable, but invalidation delivery
is best-effort in the MVP. Production evolution is a transactional outbox / durable
event stream that retries profile/feed invalidation until acknowledged.

Concretely, the window is this: the interaction commits, the `MULTI/EXEC` then fails
because Redis is down, and nothing retries it. The user keeps their existing feed
until its TTL expires — at most `FEED_TTL_SECONDS` — and any later interaction that
does reach Redis invalidates it anyway. So the consequence is bounded staleness
rather than permanent divergence, which is why the MVP accepts it. What it does not
have is a *guarantee*, and that is what the outbox buys.

**Interaction coalescing / debounce.** Impressions already defer to the next
generation (see the invalidation matrix), but the preference-changing events have
the same shape at scale: a single playback can legitimately emit `view` →
`complete` → `like`, and each one currently bumps the epoch and queues a build. That
is correct — the stale-epoch guard means only the last one publishes, and BullMQ's
deduplication and bounded retries keep it contained — but it is three builds where
one would do.

A production system would coalesce the events of one playback in a stream processor
and rebuild once per window per user, recovering the wasted builds without giving up
freshness. **Not implemented here**: a debounce window is a tuning decision, and
tuning it without production traffic to measure against is guesswork. The MVP
accepts the extra builds because correctness does not depend on avoiding them.

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
