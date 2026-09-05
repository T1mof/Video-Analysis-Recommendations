# Roadmap

Single source of truth for milestone status and what is deliberately deferred.
Updated 2026-09-05, after M4 closed.

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
| **M6** | Candidate generation + ranking + diversity | **NEXT** |
| **M7** | Feed serving + Redis precomputation | planned |
| **M8** | Minimal demo + architecture + documentation | planned |
| **M8.4** | GOLD-30 / HOLDOUT-15 preparation | after MVP |
| **M8.5** | Quality optimization | after MVP |
| **M8.6** | Final held-out evaluation | after MVP |
| **M9** | Scraper | optional bonus |
| **M10** | Final polish, clean-clone check, demo rehearsal | planned |

**M8.4–M8.6 do not block MVP readiness.** The critical path to a demoable system is
M5 → M6 → M7 → M8, and nothing in the quality work may delay it.

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
[ARCHITECTURE.md](../ARCHITECTURE.md#user-interactions-and-the-preference-profile).

M6 consumes this: the profile vector for similarity candidates, `tag_affinity` for
tag candidates, `user_creator_affinity` as a ranking feature, and `is_cold_start`
to decide which sources a user gets.

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

---

# M8.4 — GOLD-30 / HOLDOUT preparation

15 of 30 videos are hand-labelled today. Those 15 have already been used for model
comparison, error analysis, prompt discussion and weak-field analysis. They are
therefore a **development set**, not an independent measure:

- **DEV-15** — the current `data/gold/labels.json`. Burned: it has seen three models.
- **HOLDOUT-15** — the remaining 15 videos, to be labelled later.

Rules for HOLDOUT-15, all of them absolute:

- labelled by hand **without** looking at any new model predictions;
- **not** usable for prompt tuning;
- **not** usable for choosing sampling;
- **not** usable for model selection;
- opened **only once**, after the final configuration is frozen.

After the final run, a GOLD-30 aggregate may also be reported, but the headline
independent quality number is **HOLDOUT-15**.

---

# M8.5 — Quality optimization

Runs **only after** a working M5–M8 end-to-end pipeline exists.

Goal: find where the remaining quality headroom actually is and try to lift DEV-15
macro from 0.549 to ~0.60+, without increasing cost or complexity for its own sake.

This is a **controlled ablation**, not a chaotic model hunt. One main factor per
experiment.

## A. Frame coverage ablation

Compare on DEV-15: (1) current adaptive sampling, (2) ~12 frames, (3) ~16 frames.

Watch the fields that depend on temporal coverage: `actType`, `sexPosition`,
`penetrationType`, `clothing`, `setting`, `performerCount`.

Do not change prompt or model in the same experiment.

## B. Smarter sampling

If more frames help little or mostly produce near-duplicates, test smarter
selection: scene-change aware, motion aware, explicit start/middle/end coverage,
maximising visually distinct states.

The goal is not 16 similar JPEGs — it is covering different parts and states of the
clip.

## C. Native video input

Compare sampled JPEG frames against native video input on the **same**
Qwen3-VL-8B. Measure macro, single, multi, critical fields, latency, VRAM,
tokens/input and projected cost per 100k.

Do not assume native video wins. If cost rises multiple-fold for a small gain, keep
sampling.

## D. Prompt v3 / taxonomy mapping

One general semantic iteration of the prompt is allowed. Keep prompt v2; call the
new one **prompt v3**.

The known candidate is `clothing`:

| Model | `clothing` |
|---|---:|
| Qwen2.5-VL 3B | 0.27 |
| **Qwen3-VL 8B (selected)** | **0.07** |
| InternVL3 8B | 0.31 |

Qwen3 simultaneously scores 0.80 on `explicitness`, so it is seeing the scene and
mis-translating the observation into the enum. That is a mapping problem, not a
perception problem.

Do not add rules targeting specific DEV videos.

## E. Two-stage perception → taxonomy

One of the priority experiments.

```
now:  frames → VLM → 19 taxonomy fields directly

test: frames/video → VLM perception → neutral observations
                   → text taxonomy mapper → validated taxonomy JSON
```

Stage one answers what is visibly there. Stage two owns enum semantics, the
`none`/`unknown`/`other` distinction, taxonomy mapping and structured output.

Motivated by a real M4 observation: cases where the caption stated the correct fact
while the structured field was wrong.

## F. Temporal chunk aggregation

For longer clips: analyse start → A, middle → B, end → C, then aggregate A+B+C into
final taxonomy.

Potentially useful for changing `clothing`, multiple `setting`s, several `actType`s,
varying `sexPosition` and `penetrationType`.

Cost: more inference calls. Judge the gain against that.

## G. Focused field groups

Test whether splitting 19 fields into 2–3 narrower passes helps:

- **Pass A** — `performerCount`, `performerGender`, `hairColor`, appearance/body fields
- **Pass B** — `actType`, `sexPosition`, `penetrationType`, `fetishTags`
- **Pass C** (only if justified) — `setting`, `clothing`, `cameraStyle`, `explicitness`

Do not adopt automatically. Only if quality rises noticeably.

## H. Consistency rules

A small set of obvious post-VLM taxonomy invariants, for example:

- `penetrationType = vaginal` should agree with `actType` containing `penetrative_sex`
- `performerCount = solo` should not conflict with `performerGender = mixed`
- `explicitness = sfw` should not conflict with explicit penetration

A small set of obvious checks — not hundreds of hand-written rules.

## I. Larger Qwen

Only **after** the cheap levers: sampling, native-video comparison, prompt/mapping,
two-stage analysis.

If the ceiling then looks like model capacity, test Qwen3-VL-30B-A3B or
Qwen3-VL-32B on a GPU with enough VRAM. Do not try to squeeze a large model onto a
weak GPU.

## J. Fine-tuning

Not an MVP task. LoRA/SFT only becomes reasonable with a substantially larger
manually reviewed dataset — hundreds to thousands of examples. GOLD-30 is far too
small to make fine-tuning a priority now.

## Experiment protocol

Change **one** main factor per experiment. Record: model, prompt version, sampling
version, dataset split, runtime, config. Save each experiment's predictions
separately (`data/benchmarks/`, gitignored).

Measure on DEV: macro all / single / multi, per-field accuracy, informative
accuracy, schema failures, coverage, spurious, missed.

Look separately at the **recommendation-critical fields**: `actType`, `fetishTags`,
`penetrationType`, `sexPosition`, `performerCount`, `performerGender`, `hairColor`,
`setting`, `explicitness`.

Also measure, where comparable: mean latency, p50, p95, tokens/input, VRAM,
projected cost per 100k.

**Never** pick a configuration on aggregate macro alone when the gain came from
subjective secondary fields while critical fields got worse.

## Targets — orientation, not acceptance criteria

```
~0.55       current working MVP baseline
>= 0.60     good result for quality optimization
0.62-0.65   very strong
>= 0.70     stretch goal, not required
```

Do not optimise endlessly for a prettier number.

## Stop rules

- A change worth **≤ ~0.01–0.02 macro** that does not improve critical fields is not
  worth complicating the production pipeline for.
- If native video or temporal aggregation multiplies cost for a small gain, keep
  frame sampling.
- Test a larger model only after the cheap levers are exhausted.
- **M8.5 must never break or delay a working M5–M8 MVP.**

---

# M8.6 — Final held-out evaluation

After M8.5, freeze: model, prompt, sampling, aggregation, post-processing.

Then run **HOLDOUT-15 exactly once**. Report:

```
DEV-15 score
HOLDOUT-15 score
GOLD-30 aggregate
```

If HOLDOUT is clearly worse than DEV, record that honestly as overfitting /
selection bias rather than explaining it away.

After the final HOLDOUT result, do **not** tune the system against its errors before
the final number is recorded.
