# Session handoff — M6 complete, M7 next

Durable checkpoint. Self-contained: everything needed to resume is here or in the
files it names.

**Date:** 2026-09-06 · **M4 = `6d48ed2` · M5 = `b889295`** · M6 implemented, not yet committed.

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

## M6 — candidate generation, ranking, diversity: DONE

Five sources → union → dedupe → filter → rank → diversify → ordered list.
Modules: `src/reco/{candidates,ranking,diversity,recommender,diversityTags}.ts`.

```
score = 1.0×affinity + 0.15×quality + 0.2×freshness + 0.25×popularity
      − 0.35×fatigue + 0.1×exploration + 0.2×creatorAffinity
rerank = baseScore − 0.3 × max(0, maxCosineToSelected)
```

**Decisions worth not re-litigating:**

- **No new env keys.** Every K, weight and cap already existed from M1.
- **Quality = `aestheticScore`, never `productionQuality`.** Professional vs amateur
  is a kind of content and a plausible user preference, not a measure of a good
  recommendation. When aestheticScore is missing the feature reports
  `qualityAvailable: false` and contributes zero rather than inventing a proxy.
- **Fatigue ≠ diversity.** Fatigue looks backwards at history (recent *distinct*
  videos), diversity sideways within the list. Fatigue is scaled by how full the
  history window is — a frequency over three videos is noise and would otherwise
  outweigh every positive term.
- **Null creator is exempt from the creator cap, not pooled** — pooling would let
  anonymous videos block each other.
- **Diversity tags are one centralised policy**, excluding near-constant fields
  (`performerGender`, `explicitness`, `mediaType`); capping on those would block the
  whole feed. A compile-time assertion fails if a taxonomy change leaves a field
  unclassified.
- **Two-pass fallback** with `diversityRelaxed` in diagnostics: on 30 videos the
  caps can make a full list impossible, and a limit near the corpus size forces
  relaxation by construction.
- **Determinism everywhere**: hash-based exploration bucketed by UTC day, ties
  broken on videoId.
- **Popularity is normalised over the whole trending window, not the caller pool**,
  so a video scores the same for every user at every limit. Negative engagement
  clamps to 0 - min-max over signed values would promote the *least* skipped video
  to 1.0 in a window where everything was skipped.
- **Integration tests run one file at a time** (`fileParallelism: false`): they share
  one Postgres, and trending popularity is a global aggregate, so a concurrent file
  inserting events changed what another was measuring.

Demo: `npm run demo:recommendations`. Alice and Bob share 5 of 10 videos in
different orders; `video_25` is Bob's #1 and Alice's #10 (affinity −0.201). Carol is
cold-start: similar 0, tag 0, served from trending/fresh/explore. ~10 ms per user.

## Quality work: M8.4 – M8.7 — planned, does NOT block M7–M8

The full strategy lives in **[ROADMAP.md](ROADMAP.md)** — 12 numbered M8.5 steps,
protocol, targets and stop rules. It survives compaction there; this is the summary.

- **M8.4** — the current 15 labelled videos are **DEV-15**, burned as an independent
  measure: they have scored three models and informed prompt discussion. The
  remaining 15 become **HOLDOUT-15** — hand-labelled without seeing predictions,
  never used for prompt tuning, sampling choice, model selection or picking
  consistency rules, opened exactly once after the configuration is frozen.
- **M8.5** — **pipeline first, models last.** The model stays fixed at Qwen3-VL-8B
  while the pipeline is understood: (1) error decomposition into perception /
  temporal coverage / taxonomy-mapping / ambiguity / consistency classes, (2) prompt
  v3 on general semantics, (3) **two-stage perception → taxonomy mapping**, (4)
  frame-coverage ablation, (5) smarter sampling, (6) native video, (7) temporal
  chunk aggregation, (8) a small consistency layer. Only then models: (9) a
  new-generation Qwen (candidate Qwen3.5-9B), (10) a cross-family open-weight
  competitor chosen at the time, (11) an optional hosted model subject to policy and
  retention, (12) a large model only if capacity is proven to be the limit.
  Starting with a model sweep would blame model capacity for a prompt bug.
- **M8.6** — freeze everything, open HOLDOUT-15 **once**, report DEV-15 /
  HOLDOUT-15 / GOLD-30, and record overfitting honestly if HOLDOUT is worse.
- **M8.7 — optional, and not part of the VLM work.** Learned-ranker readiness:
  synthetic users with *hidden* preferences (never given to the ranker) generate
  interactions, then LR/LightGBM/LambdaMART is compared against the M6 heuristic on
  NDCG@K / Recall@K. It proves the feature and training pipeline can support a
  learned ranker — **never** quote it as production recommendation quality.

Targets are orientation, not acceptance criteria: `~0.55` now, `>=0.60` good,
`0.62-0.65` very strong, `>=0.70` stretch. Stop rules: no model zoo; a change worth
≤0.01–0.02 macro that does not improve recommendation-critical fields is not worth
complicating the pipeline for.

**Model search is closed until M8.5.** Do not resume it and do not delay M6–M8
chasing a higher macro. `VLM tag macro != recommendation quality` — the feed is
judged on the feed.

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

`typecheck 0` · `lint 0` · `tests 299 passed, 5 skipped` (with `TEST_INTEGRATION=1`;
without it the 4 integration files are skipped) · `check:env` in sync at 78 keys

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
| M6 | candidate generation + ranking + diversity | **DONE** |
| **M7** | **feed serving + Redis precomputation** | **NEXT** |
| M8 | minimal demo + architecture + documentation | planned |
| M8.4–M8.6 | HOLDOUT-15 prep, VLM quality optimization, held-out eval | after MVP |
| M8.7 | learned-ranker readiness | optional |
| M9 | scraper | optional bonus |
| M10 | final polish, clean-clone check, demo rehearsal | planned |

**M7 — feed serving.** It consumes what M6 built:

| M6 output | M7 use |
|---|---|
| `recommendCandidates(userId, limit)` | what a background job calls to fill a feed |
| ordered list + diagnostics | the payload cached in Redis |
| `candidateShortage` | the signal that a repeat/backfill policy is needed |

The shape is already decided and is the reason the 3k RPS design works:
`GET /feed` must be a Redis read, with **no** code path from an HTTP request to
pgvector or to the ranker — not as a fallback, not behind a flag. Feeds are filled
by prewarm, by an event-driven rebuild, and a cache miss is served from the
precomputed global trending feed. Then M8 (UI, docs, demo). Scraper is the bonus at
the end. Full milestone table and quality-work strategy: [ROADMAP.md](ROADMAP.md).
