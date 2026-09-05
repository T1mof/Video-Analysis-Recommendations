# Session handoff — M5 complete, M6 next

Durable checkpoint. Self-contained: everything needed to resume is here or in the
files it names.

**Date:** 2026-09-05 · **M4 committed as `6d48ed2`** · **M5 implemented, not yet committed.**

---

## M5 — user interactions and profile: DONE

```
profile = Σ(eventWeight × timeDecay × videoVector) / Σ|eventWeight × timeDecay|
decay   = 0.5 ^ (ageDays / halfLifeDays)
```

| Event | Weight | | Event | Weight |
|---|---:|---|---|---:|
| `impression` | 0.00 | | `like` | +1.00 |
| `view` / `watch` | +0.25 | | `skip` | −0.50 |
| `complete` | +0.60 | | `dislike` | −1.00 |

Half-life 7 days (`PROFILE_HALFLIFE_DAYS`), cold start below 5 effective signals
(`COLD_START_MIN_INTERACTIONS`) — both already existed in config from M1 and were
reused, not re-invented.

**Decisions worth not re-litigating:**

- **Reused the `events` table** instead of adding an `interactions` table. `events`
  already had the enum, `watchMs`, `positionPct` (= watch ratio) and the right
  indexes; a second table would have been a parallel mechanism for the same thing.
  Added `event_id` (unique, nullable) for idempotency and `dislike` to the enum.
- **Weights are constants in `src/reco/signals.ts`, not env vars.** Six knobs nobody
  turns in a one-week MVP is deployment surface without capability.
- **Creator affinity is a separate table**, never a taxonomy dimension: creator
  identity is not content, and folding it in would force a re-embed whenever the
  creator set changed. Ranking feature in M6, never a hard filter.
- **Negative dimensions are not clamped.** A positive-only profile cannot recover
  from a bad streak.
- **Normalised by Σ|signal|**, so profiles are comparable across users and repeating
  an interaction reinforces rather than inflates.
- **Full rebuild per write** is the MVP choice; `computeProfile()` is pure so the
  production streaming path reuses it unchanged.
- **`watch` is not accepted by the API.** The M1 enum shipped both `view` and
  `watch` meaning the same thing; with equal weights a client emitting both for one
  playback would have contributed +0.50 instead of +0.25. `watch` keeps its weight
  so any legacy row still scores, but intake accepts only the canonical six types
  (`ACCEPTED_EVENT_TYPES`), which `GET /signals` advertises. Watch *duration* rides
  on `positionPct`, not on a second event type.

New: `src/reco/{signals,profile,interactions}.ts`, `src/api/server.ts` (POST
`/interactions`, GET `/users/:id/profile`, `/signals`, `/health`),
`scripts/{seed-users,simulate-events}.ts`, migration `0003`, 43 tests.

Also fixed a latent bug: `src/db/migrations/meta/0002_snapshot.json` carried a UTF-8
BOM that made `npm run db:generate` fail for anyone, including a clean clone.

`npm run demo:profile -- --reset` runs the deterministic two-user scenario.

---

## M4 — VLM analysis and model selection: DONE

**Selected model: `Qwen/Qwen3-VL-8B-Instruct-FP8`**, served by vLLM 0.11.0.

```
macro all     0.549
macro single  0.517
macro multi   0.722
coverage      15/15 gold, 30/30 corpus
```

0.549 is a sufficient MVP baseline, **not** a quality ceiling. The recommender is
designed to tolerate imperfect features: confidence weighting, `unknown` contributes
zero to the content vector, and candidate generation is multi-source so no single
signal has to be right. Improvements are scoped as **M8.5** (below), after the MVP.

### Three models, same 15 gold videos (now called **DEV-15**)

Held constant: taxonomy v2, prompt v2, M3 sampler, 768 px frames, same gold ids,
same metrics, concurrency 1, prompt-enforced JSON in all three runs.

| Metric | Qwen2.5-VL 3B | **Qwen3-VL 8B FP8** | InternVL3 8B BF16 |
|---|---:|---:|---:|
| Coverage | 100% | **100%** | 86.7% (13/15) |
| Schema failures | 0 | **0** | 2 |
| Macro, valid-only | 0.399 | **0.549** | 0.420 |
| Macro, end-to-end | 0.399 | **0.549** | 0.364 |
| single / multi (valid-only) | 0.383 / 0.485 | **0.517 / 0.722** | 0.380 / 0.632 |
| Tokens per frame | 1,230 | **528** | 971 |

*End-to-end* scores a video with no valid output as 0 on every field. It equals
valid-only at 100% coverage, which is why the Qwen columns repeat. Never quote
valid-only across models with different coverage — it rewards refusing videos.

InternVL3's failures are systematic and land on recommendation-critical fields:
`mixed → female` 12×, `duo → solo` 9×, `vaginal → none` 6×, `explicit → nudity` 6×.
`performerGender` scored 0.00. It sees only the female performer and under-states
explicit activity.

Full analysis: [MODEL_COMPARISON.md](MODEL_COMPARISON.md) ·
[COST_MODEL.md](COST_MODEL.md) · per-model reports `BENCHMARK-*.md` · raw predictions
in `data/benchmarks/` (gitignored).

### Benchmark bug found and fixed

The first InternVL3 run reported **macro 0.446 over 15/15** — **invalid, unused**.
Under `--no-persist`, scoring fell back to the stored DB row when a prediction was
missing, so on the two videos InternVL3 failed, **Qwen3's features were scored as
InternVL3's**. The incumbent inflated the challenger exactly where the challenger
collapsed.

Fixed: `--no-persist` and `--load-predictions` never read the DB; a missing
prediction stays missing and shrinks coverage; the report prints the real sample.
`summarize(results, attempted)` now returns coverage plus failure-penalised scores.
Tests in `tests/analysis/gold.test.ts`.

Re-score any saved run without a GPU:

```bash
npm run bench-vlm -- --load-predictions data/benchmarks/internvl3-8b-gold.json
```

---

## Remote GPU experiment — closed

The rented RTX 4090 (`n1.us.clorecloud.net:1887`, 41.06 RUB/hour) has been audited
and cleaned. All experiment artifacts removed; only the provider's own
`onstart.sh` and `cc-agent.py` remain. GPU idle at 27 MiB, no inference processes.

No project input videos, sampled frames, or request payloads were found remaining
on the guest VM after the final audit. That audit covers only the guest VM
filesystem and running processes — it cannot prove physical erasure from the cloud
provider's underlying storage, snapshots, or infrastructure.

**Status: the VM was deleted from the provider panel on 2026-09-05. The host is gone,
billing has stopped, and the remote GPU experiment is finally closed.** Nothing in
the project depends on it: every result is in this repository, and the raw
predictions for all three models are in `data/benchmarks/`.

If a future run is ever needed on a fresh host, these environment constraints cost
real time and should not be re-learned: pin vLLM (unpinned pulls torch+cu130, which
needs driver ≥580 — that host was 12.4), require `transformers>=4.57,<5` (5.x removed
`Tokenizer.all_special_tokens_extended`), and leave flashinfer uninstalled on Python
3.10 (it needs 3.11+, and is only for multi-GPU). Serve on loopback and reach it over
an SSH tunnel; never expose the endpoint.

---

## Quality work: M8.4 / M8.5 / M8.6 — planned, does NOT block M5–M8

The full strategy lives in **[ROADMAP.md](ROADMAP.md)** — experiment list, protocol,
targets and stop rules. It survives compaction there; this is only the summary.

- **M8.4** — the current 15 labelled videos are now **DEV-15** (burned: they have
  scored three models). The remaining 15 become **HOLDOUT-15**, labelled by hand,
  never used for prompt tuning, sampling choice or model selection, opened once
  after the final configuration is frozen.
- **M8.5** — controlled ablation, one factor per experiment: frame-coverage sweep,
  smarter sampling, native video vs frames, prompt v3, **two-stage perception →
  taxonomy mapping**, temporal chunk aggregation, focused field groups, a few
  consistency invariants, and a larger Qwen only after the cheap levers.
- **M8.6** — freeze everything, run HOLDOUT-15 **once**, report DEV-15 /
  HOLDOUT-15 / GOLD-30, and record overfitting honestly if HOLDOUT is worse.

Targets are orientation, not acceptance criteria: `~0.55` now, `>=0.60` good,
`0.62-0.65` very strong, `>=0.70` stretch. Stop rule: a change worth ≤0.01–0.02
macro that does not improve recommendation-critical fields is not worth complicating
the pipeline for.

**Model search is closed.** Do not resume it and do not delay M5–M8 chasing a higher
macro. `VLM tag macro != recommendation quality` — the feed is judged on the feed.

Two known findings deliberately left alone, both recorded:

- `clothing`: 0.27 (3B) / **0.07** (8B) / 0.31 (InternVL3). A weaker model scoring
  4× higher on identical frames proves this is a prompt problem, not a corpus
  problem. Tuning prompt v2 against these 15 videos would overfit the gold set and
  contaminate every past comparison — belongs in M8.5 with a held-out set.
- `adultAgeGroup`: informative accuracy 0.00 on all three models. Candidate for
  redesign or removal in **taxonomy v3**, not v2.

---

## Integrity — verified

- `data/gold/labels.json` sha256 `F0ECA0EB30D2E72769772BAD68A17BE3FAF60A5ED29833247CBA83C7788855E6` — **unchanged**
- `src/analysis/taxonomy.ts` — unchanged (v2 frozen, `TAXONOMY_DIM=110`)
- Prompt v2 — unchanged, never tuned against gold results
- Database — 30 `qwen3-vl-8b-fp8` rows, all 30 videos `analyzed`; the InternVL3 run
  used `--no-persist` and never touched them

### Checks

`typecheck 0` · `lint 0` · `tests 224 passed, 5 skipped` (with `TEST_INTEGRATION=1`;
without it the 3 integration files are skipped) · `check:env` in sync at 78 keys

---

## Standing constraints

Do not change taxonomy v2, the gold set, prompt v2, the sampler or frame resolution.
Do not tune the prompt against observed gold errors. Do not overwrite the Qwen3
corpus — evaluate with `--no-persist`. No further models before M8.5. No commits
without the owner's confirmation.

## Next

| | | |
|---|---|---|
| M0–M3 | infra, taxonomy v2, ingestion, DEV-15, preprocessing | **DONE** |
| M4 | VLM analysis + model selection | **DONE** |
| M5 | user interactions + user profile | **DONE** |
| **M6** | **candidate generation + ranking + diversity** | **NEXT** |
| M7 | feed serving + Redis precomputation | planned |
| M8 | minimal demo + architecture + documentation | planned |
| M8.4–M8.6 | GOLD-30/HOLDOUT prep, quality optimization, held-out eval | after MVP |
| M9 | scraper | optional bonus |
| M10 | final polish, clean-clone check, demo rehearsal | planned |

**M6 — candidate generation, ranking and diversity.** It consumes what M5 built:

| M5 output | M6 use |
|---|---|
| `user_profiles.embedding` | pgvector similarity candidates |
| `user_profiles.tag_affinity` | tag candidates over the jsonb features |
| `user_creator_affinity` | ranking feature — never a hard filter |
| `is_cold_start` | which sources a user gets when there is no taste yet |
| negative dimensions | active dislikes, not absence of evidence |

Shape already decided: five candidate sources → union → dedup → filter → rank →
diversity, with the numeric ranking features (aesthetic, freshness, popularity,
creator affinity, exploration) kept outside the taxonomy vector. Then M7
(Redis-first `GET /feed`), M8 (UI, docs, demo). Scraper is the bonus at the end.
Full milestone table, quality-work strategy and cutting rules:
[ROADMAP.md](ROADMAP.md).
