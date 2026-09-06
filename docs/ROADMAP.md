# Roadmap

Single source of truth for milestone status and what is deliberately deferred.
Updated 2026-09-06, during M8.

## Status

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Infrastructure — Docker Compose, Postgres + pgvector, Redis, MinIO, config | **DONE** |
| **M1** | Taxonomy v2 (19 fields, 110 dims, frozen layout) + DB schema | **DONE** |
| **M2** | Ingestion — local corpus, dedupe, poster frames, S3 + Postgres | **DONE** |
| **M2b** | Gold **DEV-15** — 15 hand-reviewed videos | **DONE** |
| **M3** | Video preprocessing — adaptive sampling, dHash dedupe, contact sheets | **DONE** |
| **M4** | VLM analysis + model selection | **DONE** |
| **M5** | User interactions + user profile | **DONE** |
| **M6** | Candidate generation + ranking + diversity | **DONE** |
| **M7** | Feed serving + Redis cache + API | **DONE** |
| **M8** | Demo UI + architecture + final MVP documentation | **IN PROGRESS** |
| **M8.4** | Evaluation dataset preparation — HOLDOUT-15 | **NEXT**, after MVP |
| **M8.5** | VLM quality optimization — pipeline first, models last | after MVP |
| **M8.6** | Final held-out evaluation | after MVP |
| **M8.7** | Learned-ranker readiness | **optional**, after MVP |
| **M9** | Scraper | optional bonus |
| **M10** | Final polish, clean-clone check, demo rehearsal | planned |

**M8.4–M8.7 do not block MVP readiness.** The critical path to a demoable system is
M5 → M6 → M7 → M8, and nothing in the quality work may delay it. M8.7 is optional
even among those.

## What M5 delivered

Interactions → signed, time-decayed preference profile in the same 110-dimension
space as the videos, plus creator affinity and a cold-start flag.

```
profile = Σ(eventWeight × timeDecay × videoVector) / Σ|eventWeight × timeDecay|
decay   = 0.5 ^ (ageDays / halfLifeDays)          half-life 7 days
cold    = effectiveSignalCount < 5
```

Reused the `events` table and the `PROFILE_HALFLIFE_DAYS` / `COLD_START_MIN_INTERACTIONS`
config laid down in M1 rather than introducing a parallel mechanism; added
idempotency (`events.event_id`), profile diagnostics columns and a
`user_creator_affinity` table. Full reasoning in
[ARCHITECTURE.md §8](../ARCHITECTURE.md#8-user-interactions-and-the-preference-profile).

M6 consumes this: the profile vector for similarity candidates, `tag_affinity` for
tag candidates, `user_creator_affinity` as a ranking feature, and `is_cold_start`
to decide which sources a user gets.

## What M6 delivered

Five candidate sources (similar, tag, trending, fresh, explore) → union → dedupe →
filter → weighted ranking → diversity reranking → ordered list, with a per-item
score breakdown.

```
score = 1.0×affinity + 0.15×quality + 0.2×freshness + 0.25×popularity
      − 0.35×fatigue + 0.1×exploration + 0.2×creatorAffinity
```

All weights and caps come from the config laid down in M1; M6 added no new env keys.
Weights are **heuristic priors** — see M8.7 for the learned-ranker path. Full design
in [ARCHITECTURE.md §9–§11](../ARCHITECTURE.md#9-candidate-generation).

M7 consumes this: `recommendCandidates()` is what a background job calls to fill a
user's Redis feed. Nothing in M6 runs on the request path.

## What M7 delivered

Background feed builds into an immutable Redis generation behind an active
pointer; `GET /feed` reads Redis and nothing else.

```
GET /feed            -> Redis -> response
miss / invalidation  -> BullMQ (deduped on user+epoch) -> feed worker -> M6 -> Redis
```

Epoch guards against a slow build overwriting a newer one; every accepted
interaction invalidates and a duplicate does not; cursors are opaque and bound to
one user and generation. No synchronous recommendation fallback anywhere: a miss
is 202, a cache outage is 503. Reused `FEED_SIZE`, `FEED_TTL_SECONDS` and
`FEED_REFILL_WATERMARK` from M1 - no new env keys, no migrations.

M8 consumes this: the UI is a client of `GET /feed` and `POST /interactions`.

## What M8 delivered

One demo page at `/demo` and a finished documentation set.

```
GET /demo  ->  vanilla HTML/CSS/JS via @fastify/static  ->  client of the ordinary API
GET /demo/api/feed-debug  ->  one Redis key  ->  why each item is where it is
```

The explanation is a **sidecar projected at feed-build time**, never recomputed: the M6
result already holds every feature and weighted term and then discards them, so the worker
captures them once into `feed:debug:{userId}:{feedId}`, published and evicted by the same
retention rule as the generation. The demo endpoint imports neither the recommender nor any
database module, and a test makes the recommender throw to keep it that way. MEASURED at
~1.6 KB/item against the feed payload's 96 B/item, so it is a demonstration surface rather
than a production default.

`ARCHITECTURE.md` was restructured into 18 numbered sections with a table of contents and a
Mermaid overview diagram, and `README.md` into reviewer-first order. New:
[DEMO_SCRIPT.md](DEMO_SCRIPT.md) and [DEMO_CHEATSHEET.md](DEMO_CHEATSHEET.md). Four
documentation contradictions and two factual errors were found and fixed — details in
[SESSION_HANDOFF.md](SESSION_HANDOFF.md).

**M8.4 is next and must not be started early.**

## Current VLM baseline — frozen

MVP model: **`Qwen/Qwen3-VL-8B-Instruct-FP8`**

```
DEV-15    macro all 0.549 · single 0.517 · multi 0.722 · coverage 15/15
```

This is a working baseline, **not a quality ceiling**. Model search is closed for
now: do not resume it, and do not delay M5–M8 chasing 0.60–0.70. The selection stays
fixed until M8.5. Evidence in [MODEL_COMPARISON.md](MODEL_COMPARISON.md).

## The product principle that orders this roadmap

```
VLM tag macro != recommendation quality
```

The deliverable is judged end to end:

```
video → VLM features → user profile → candidate generation → ranking → diversity → feed
```

A better tagger with no feed is worth less than a working feed on a 0.549 tagger.
Hence M5 → M6 → M7 → M8 first, quality work after.

# M8.4 — Evaluation dataset preparation

15 of 30 videos are hand-labelled today, and they have already been used for model
selection, error analysis and discussion of prompt failures. **They are therefore no
longer an independent test set.** They are a development set:

- **DEV-15** — the current `data/gold/labels.json`. Burned: it has scored three models.
- **HOLDOUT-15** — the remaining 15 videos, to be labelled by hand later.

Rules for HOLDOUT-15, all absolute — a held-out set is worth nothing the moment it
leaks:

- labelled by hand, **without** looking at any new model predictions;
- **not** used for prompt tuning;
- **not** used for sampling selection;
- **not** used for model selection;
- **not** used for choosing consistency rules;
- opened **only** after the final configuration is completely frozen.

After the final evaluation a GOLD-30 aggregate may also be reported, but the
headline independent number is **HOLDOUT-15**.

---

# M8.5 — VLM quality optimization

Runs **only after** a working M5–M8 end-to-end pipeline exists.

**Do not start M8.5 by trying new models.** The model stays fixed at
`Qwen/Qwen3-VL-8B-Instruct-FP8` while the pipeline around it is understood and
improved. Baseline to beat:

```
DEV-15   macro all 0.549 · single 0.517 · multi 0.722
```

The goal is to find where the remaining error actually comes from, fix the cheap
pipeline-level causes, and only then ask whether a different model adds anything on
top. A model sweep run first would attribute pipeline defects to model capacity and
buy an expensive model to fix a prompt bug.

One main factor per experiment, throughout.

## Step 1 — Error decomposition

Classify the substantive errors the current Qwen3 makes on DEV-15:

| Class | Meaning |
|---|---|
| **A. Perception** | The model genuinely did not see the object, person or action. |
| **B. Temporal coverage** | The needed state was never in the sampled frames. |
| **C. Taxonomy / mapping** | The caption states the fact correctly; the structured field is wrong. |
| **D. Taxonomy ambiguity** | The category is itself visually or semantically ambiguous. |
| **E. Structured consistency** | Several fields contradict each other. |

Produce a compact per-field error report and let it choose the experiments below.
Each class has a different fix — a mapping error is a prompt problem, a coverage
error is a sampling problem, and treating one as the other wastes the milestone.

## Step 2 — Prompt v3 / taxonomy mapping

The first optimization after the analysis. Prompt v2 stays as an immutable
baseline; the new one is **prompt v3**.

Correct only general semantics: `none` vs `unknown` vs `other`, dominant performer,
dominant state, multiple scenes or states, and choosing the most specific
applicable enum value. **No rules targeting specific video IDs.**

`clothing` gets particular attention:

| Model | `clothing` |
|---|---:|
| Qwen2.5-VL 3B | 0.27 |
| **Qwen3-VL 8B (selected)** | **0.07** |
| InternVL3 8B | 0.31 |

The selected model is simultaneously the best of the three on `explicitness`
(0.80). A model that reads explicitness well while scoring 0.07 on clothing is not
failing to see the scene — it is mapping the observation onto the wrong enum. That
is a prompt/taxonomy-mapping problem, and it is the cheapest kind to fix.

Compare prompt v2 against v3 on DEV.

## Step 3 — Two-stage perception → taxonomy

The priority architectural experiment.

```
baseline:    frames → VLM → 19 taxonomy fields directly

experiment:  frames → visual perception → neutral observations
                    → text taxonomy mapper → validated taxonomy JSON
```

Stage one describes observable facts without trying to guess enum values. Stage two
owns taxonomy semantics, enum mapping, the `none`/`unknown`/`other` distinction and
structured output. The mapper can be a cheaper text model or a second text-only
pass of the same model.

Directly motivated by M4: cases were observed where the caption contained the
correct fact while the structured field did not. If Step 1 finds class C dominates,
this is the structural answer to it.

Measure macro, critical fields, latency and token/cost overhead.

## Step 4 — Frame coverage ablation

With model and prompt held fixed, compare current adaptive sampling against ~12 and
~16 frames.

Watch the temporally sensitive fields: `actType`, `sexPosition`, `penetrationType`,
`clothing`, `setting`, `performerCount`. Identify the point of diminishing returns
rather than assuming more frames is better.

## Step 5 — Smarter sampling

If more frames help, or if the current frames turn out to be too similar to each
other, test smarter selection: uniform temporal coverage, scene-change awareness,
motion/change peaks, visual diversity, explicit beginning/middle/end coverage.

The goal is maximum information, not maximum JPEGs.

## Step 6 — Native video input

Compare sampled frames against native video input on the same Qwen model and config
where possible. Measure macro, single, multi, critical fields, latency,
tokens/input, VRAM and projected cost per 100k.

Do not choose native video if a small quality gain costs several times more.

## Step 7 — Temporal chunk aggregation

Only if the Step 1 analysis shows it is needed.

```
beginning → observation A
middle    → observation B          A+B+C → aggregator → final taxonomy
end       → observation C
```

Potentially useful for changing `clothing`, changing `setting`, multiple acts and
multiple positions. Costs extra inference calls per video; do not adopt it unless
the gain justifies them.

## Step 8 — Consistency layer

A small deterministic validator after the VLM, covering only obvious taxonomy
invariants — for example a `solo` performer count with a `mixed` performer gender,
explicit penetration recorded with no corresponding act, or plainly incompatible
explicitness and action values.

Only rules that follow logically from the frozen taxonomy semantics. **Not a rule
engine.**

## Step 9 — New-generation model

Only now, and only after freezing the prompt, sampling, mapping, aggregation and
consistency strategy chosen above.

The first model experiment is a current new-generation Qwen of roughly the same
class — candidate at time of writing: **Qwen3.5-9B**. The question is what a
generation improvement is worth, not what a huge model is worth.

## Step 10 — Cross-family open-weight model

Test at least one current independent open-weight competitor through the same
frozen evaluation pipeline.

The candidate is chosen by the state of the ecosystem at the time of M8.5 — this
roadmap deliberately does not pin a model that will be stale by then. InternVL3
does not need repeating unless there is a technical reason or a new generation.

## Step 11 — Hosted model (optional)

Optionally test one current cost-efficient hosted multimodal model, and only if:

- the provider's policy permits this lawful content-classification use case;
- no bypassing of safety controls is required;
- privacy and data-retention terms are acceptable;
- the cost is understood.

Pick the candidate at experiment time rather than hardcoding a version that will
have aged. This is a separate comparison on quality, cost, latency, privacy and
operational constraints — not just accuracy.

## Step 12 — Large model

Only if the earlier steps show quality is genuinely limited by model capacity.

Test a current large VLM — a larger Qwen3.5-class model or a strong comparable
competitor. **Parameter count is not a goal in itself.**

## Experiment protocol

One main factor per experiment. Record: model and version, prompt version, sampling
version, dataset split, runtime, quantisation, hardware, structured-output mode.
Save each experiment's raw predictions separately (`data/benchmarks/`, gitignored).

Measure: macro all / single / multi, coverage, schema failures, per-field accuracy,
informative accuracy, multi-value Jaccard / precision / recall, spurious and missed
tags.

Look separately at the **recommendation-critical fields**: `actType`, `fetishTags`,
`penetrationType`, `sexPosition`, `performerCount`, `performerGender`, `hairColor`,
`setting`, `explicitness`.

Also, where applicable: latency, tokens, VRAM, projected cost per 100k.

**Never** select a configuration on aggregate macro alone when the gain came from
subjective secondary fields while critical fields got worse.

## Targets — orientation, not acceptance criteria

```
~0.55       current working MVP baseline
>= 0.60     good result for quality optimization
0.62-0.65   very strong
>= 0.70     stretch goal, not required
```

## Stop rules

- **Do not turn M8.5 into a model zoo.**
- A change worth **≤ 0.01–0.02 macro** that does not improve critical fields is not
  worth complicating the production pipeline for.
- If an expensive temporal or native-video solution gives a small gain, keep frame
  sampling.
- Run the model sweep only after pipeline optimization.
- Test a large model only after the cheap levers.
- M8.5 must never break or delay a working M5–M8 MVP.

---

# M8.6 — Final held-out evaluation

After M8.5, freeze everything: model, prompt, sampling, perception/mapping strategy,
aggregation, consistency rules.

Then open **HOLDOUT-15 exactly once** and run the final evaluation. Report
separately:

```
DEV-15
HOLDOUT-15
GOLD-30 aggregate
```

If HOLDOUT is clearly worse than DEV, record that as selection bias / overfitting
rather than explaining it away. Do **not** tune the final configuration against
HOLDOUT before the result is recorded.

---

# M8.7 — Learned-ranker readiness (optional)

**Not part of VLM quality optimization.** A separate optional experiment after the
recommender works, and it must not take time from M6–M8, M8.5 or M8.6.

The goal is to demonstrate that the M5/M6 architecture can move from heuristic
ranking weights to a learned ranker once real production interactions exist.

## Synthetic ground truth

There are no real production user logs, so synthetic users are used **as
engineering validation only**.

Create synthetic users with hidden preference vectors and creator affinities. Those
hidden preferences are **never** given to the recommender or the ranker. A separate
simulator generates stochastic impressions, views, completes, skips and
likes/dislikes from them — which yields a synthetic ground-truth relevance for each
user–video pair.

Split training from evaluation: different synthetic users and/or held-out
interactions. Never train and evaluate on the same events.

## The ranker

Use the features M6 actually produces — content similarity, tag affinity, creator
affinity, freshness, popularity, fatigue, exploration/context features.

Start with logistic regression, LightGBM or LambdaMART. **Not** a neural ranker.

Compare heuristic M6 ranking against the learned ranking on the synthetic ground
truth, using ranking metrics: NDCG@K, Recall@K / HitRate@K, and AUC for interaction
prediction where useful. Plain classification accuracy is **not** a recommendation
metric.

## The disclaimer that must accompany any result

M8.7 is **not** a measure of real recommendation quality.

Do not write: *"production recommender NDCG = X"*.

Write: *"synthetic validation demonstrates that the feature, logging and training
pipeline can support a learned ranker once real interaction data becomes
available."*

Synthetic data can prove engineering readiness. It cannot prove anything about real
user preferences — the simulator's hidden preferences are an assumption, and a
ranker that recovers them has only recovered the assumption.

When real traffic exists, the path is:

```
impressions + positions + interactions → offline training dataset
→ learned ranker → offline evaluation → A/B test → production rollout
```
