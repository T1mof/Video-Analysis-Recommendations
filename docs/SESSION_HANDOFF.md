# Session handoff — M8 in progress

Durable checkpoint. Self-contained: everything needed to resume is here or in the
files it names.

**Date:** 2026-09-06

| Milestone | Status | Commit |
|---|---|---|
| M4 — VLM analysis + model selection | **DONE** | `6d48ed2` |
| M5 — interactions + profile | **DONE** | `b889295` |
| M6 — candidates + ranking + diversity | **DONE** | `1ace4e1` |
| M7 — feed serving + Redis cache + API | **DONE** | `da96ac8` |
| **M8 — demo + architecture + documentation** | **IN PROGRESS** | uncommitted |

---

## M8 — demo, architecture, documentation: IN PROGRESS

One demo page at `/demo`, an explanation sidecar behind it, and the documentation set
brought to a finished state.

**New code:** `src/api/demo.ts` (static mount + `GET /demo/api/feed-debug`),
`src/feed/debug.ts` (sidecar types + projection), `public/{index.html,app.js,styles.css}`,
`scripts/demo-reset.ts`. Modified: `src/feed/cache.ts` (sidecar key, publish, eviction,
read), `src/feed/worker.ts` (project and publish the sidecar), `src/api/server.ts`
(register demo routes), `eslint.config.js` (lint `public/**/*.js` with browser globals).

**Decisions worth not re-litigating:**

- **The demo page is a client of the ordinary API.** `GET /feed`, `POST /interactions`,
  `GET /users/:id/profile`. What a reviewer sees in the browser is the real serving path.
  The only demo-specific endpoint is the explanation reader.
- **The explanation is a sidecar projected at build time, never recomputed.** The M6 result
  already holds every feature and weighted term and then discards them, because a *feed*
  payload must be small. `projectFeedDebug` captures them once, in the worker, into
  `feed:debug:{userId}:{feedId}`. The demo endpoint imports neither the recommender nor any
  database module; a test makes the recommender throw to keep it that way.
- **The sidecar is published by `publishGeneration`, not by a second writer**, so retention
  has exactly one implementation and an explanation cannot outlive the ranking it explains
  or survive as an orphan.
- **It is not free: MEASURED 1.6 KB/item against the feed payload's 96 B/item**, ~17×, so
  it is gated by `FEED_DEBUG_SIDECAR` with a **code default of `false`**. The one new env
  key of M8. `.env.example` sets it to `true` because that file *is* the local demo
  configuration; a deployment that changes nothing writes no diagnostics. The flag governs
  the **writer** — the endpoint serves a sidecar if one exists, and distinguishes
  `debug_sidecar_disabled` from `no_debug_data` so the page can say which.
  `buildFeed(job, { withDebugSidecar })` takes it explicitly so tests never depend on
  ambient config. Production and demo Redis memory are documented separately in
  ARCHITECTURE §12 and must not be added together.
- **No auto-impressions from the UI.** Impressions mark videos seen; sending them on every
  render would shrink the candidate pool on a 30-video corpus and degrade the demo as it
  ran. The five preference-changing controls are the spec'd set anyway.
- **`demo:reset` wraps the M5 simulation** rather than being a second dataset generator,
  and additionally clears cached generations and pending jobs — which the simulation knows
  nothing about. Without that, a reset leaves feeds ranked against the *previous* profile.
- **Demo routes are mounted unconditionally**, including under `NODE_ENV=production`. A
  deployment would gate or omit them. Recorded as a limitation rather than solved with an
  env key the milestone did not ask for.
- **`public/**/*.js` is linted, not ignored.** It caught a missing function on the first
  run.

**Documentation rebuilt:** `ARCHITECTURE.md` restructured into 18 numbered sections with a
table of contents and a Mermaid overview diagram separating offline / interaction /
background / hot path; `README.md` into reviewer-first order; new `docs/DEMO_SCRIPT.md` and
`docs/DEMO_CHEATSHEET.md`.

**Contradictions found and fixed:**

- `docs/BENCHMARK.md` did not exist — two links pointed at it. Now
  `BENCHMARK-qwen3vl-8b-rented.md` / `BENCHMARK-qwen2.5vl-3b-local.md`.
- The status header claimed cost estimation and the failure matrix "arrive with M2–M6";
  the closing line listed video analysis, the recommender and cost estimation as still
  missing. All three existed.
- The trending fallback appeared in the 3k RPS failure matrix with no marker, contradicting
  the same document's statement that it is not implemented. Every mention is now labelled
  CURRENT MVP (202) or FUTURE (design).
- The feature-model table claimed ranking features live in `video_stats`. They do not.

**Two factual corrections, both evidenced:**

- **Frames per video: 7.5 → 7.1.** 212 kept frames ÷ 30 videos = 7.07, and
  `COST_MODEL.md` independently reports 7.1 MEASURED from `frames_used`. The 7.5 was stale.
- **`video_stats` and `user_seen` are dead schema** — declared in M1, and grep finds no
  reader or writer anywhere outside the schema file and migrations. Trending aggregates
  `events` on read; "seen" is derived as distinct videos with any event. Recorded in
  ARCHITECTURE §6 and the limitations list rather than dropped: a table drop is a migration
  and belongs with the taxonomy-v3 work.

**Same-epoch duplicate build — found during the walkthrough, then fixed.** A single `like`
consumed both generation-retention slots: the interaction queues a build at the new epoch;
the client's next `GET` sees the dropped pointer, answers 202 and queues another at the
*same* epoch. BullMQ releases a deduplication key when its job completes, so the second job
was admitted — and the epoch guard rejects only *older* epochs, not equal ones. Both
published, and the second evicted the generation the user was still reading.

Fixed in `src/feed/worker.ts` with two checks — before the ranking pass and again before
publishing — for an active generation whose `epoch` equals the job's. Reported as
`already_built`, distinct from `stale`. Three things worth not re-litigating:

- **Compared against `FeedGeneration.epoch`, not a permanent marker.** A per-user "highest
  epoch built" value would forbid a legitimate rebuild after the pointer expires.
- **Applies to `miss` and `invalidation` only.** `refill` and `prewarm` exist to build a new
  generation *while* one is active; a blanket rule would have silently disabled refill.
- **Not the same problem as interaction coalescing.** That is `view → complete → like`
  producing three *different* epochs — a tuning question, still future work (§18). This was
  two builds for one epoch.

Tests: `tests/integration/feedBuild.test.ts`, cases A–F.

**One pre-existing fragile test, fixed.** `recommender.test.ts` → "gives a video the same
popularity for a different user and a different limit" asserted that a cold user's **top 3**
intersects a warm user's **top 10**. That overlap was incidental: the same database also
holds the 30-video demo corpus, whose engagement shifts every time `demo:reset` runs, and
two differently-ranked top-N lists over ~34 videos can legitimately share nothing. Running
the demo repeatedly during M8 made it fail. The limits are now 25 and 20 — still different,
so the property in the test's name is still what is checked, but the overlap is now
structural rather than luck. No M6 code changed; verified stable across a `demo:reset`.

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

## M7 — feed serving, Redis cache, API: DONE

```
GET /feed            -> Redis -> response                  (~2 ms locally)
miss / invalidation  -> BullMQ -> feed worker -> M6 -> Redis  (~12 ms build)
```

Modules: `src/feed/{cache,cursor,queue,service,worker}.ts`, entrypoint
`src/workers/feed.ts` (`npm run worker:feed`), demo `npm run demo:feed`.

Redis keys: `feed:{userId}:epoch` (no TTL), `feed:{userId}:active` (TTL 3600),
`feed:{userId}:generations` (index list), `feed:gen:{userId}:{feedId}` (TTL 2×3600,
at most 2 retained).

Memory: measured ~96 B/item, so ~1 GB payload-only lower bound for 100k users at two
retained 50-item generations; real Redis usage is higher (key overhead, index,
BullMQ, fragmentation) and was not measured.

**Decisions worth not re-litigating:**

- **No new env keys, no migrations, no dependencies.** `FEED_SIZE`,
  `FEED_TTL_SECONDS`, `FEED_REFILL_WATERMARK` already existed from M1.
- **Immutable generations behind an active pointer.** A rebuild publishes a new
  feedId; a cursor keeps reading the list it started on. Generations outlive the
  pointer 2:1 so a refresh does not break an open session.
- **Publish order is payload then pointer.** The reverse briefly names a feed that
  does not exist, and every reader would see a miss and queue another build.
- **Epoch (`INCR`) guards publication.** The worker re-reads it before publishing
  and discards a stale result — that is a normal outcome, not a failure. The same
  epoch is the BullMQ dedupe key.
- **BullMQ native `deduplication: { id, keepLastIfActive }`**, verified against the
  installed 6.3.x. `jobId` dedupe would have been wrong: it stops deduplicating once
  the completed job is evicted.
- **`impression` does NOT invalidate.** It is recorded and makes the video seen for
  the *next* build, but forces no rebuild: a client showing ten items sends ten
  impressions, and since the epoch is the dedupe key, ten epochs means ten builds —
  the mechanism that stops a cache-miss stampede cannot help. Preference-changing
  events (`view`, `complete`, `like`, `skip`, `dislike`) invalidate immediately. A
  **duplicate** invalidates nothing whatever its type. **Production evolution:
  interaction coalescing / debounce** — one playback can emit `view` → `complete` →
  `like`, three epoch bumps and three builds where one would do. Correct as it
  stands (stale-epoch guard means only the last publishes, BullMQ is bounded), but a
  stream processor should collapse them per window. Deliberately not built: a
  debounce window is a tuning decision with no production traffic to tune against.
- **The `setMaxListeners` calls are gone, and so is the leak they hid.** The
  "possible EventEmitter memory leak" warning was real: `cacheConnection()`
  registered its error handler outside the memoisation block, leaking one listener
  per cache operation (2 → 57 → 108 → 159 → 210 across measured waves). Fixed by
  registering it with the connection; counts are now flat at 1. Guarded by
  `tests/integration/redisListeners.test.ts`.
- **At most two generations per user** (`MAX_RETAINED_GENERATIONS_PER_USER`), tracked
  in a per-user index list so eviction never touches `KEYS`/`SCAN`. TTL bounds how
  *old* a generation is, not how *many* exist — without this, twenty rebuilds in two
  hours meant twenty live payloads and a memory estimate wrong by that factor. Two is
  the smallest number that lets a cursor survive one refresh; the generation before
  that returns 410.
- **Invalidation is one MULTI/EXEC** (`INCR epoch` + `DEL active`). Two loose
  commands would let a connection drop advance the epoch while the pointer survived,
  serving a pre-interaction feed until TTL. The queue write stays outside it -
  invalidate first, queue second - so a failed enqueue leaves a miss the next GET
  repairs, never a stale feed. `feedInvalidated` and `rebuildQueued` are reported
  separately because either can be true without the other.
- **Redis/queue failure never rolls back a stored interaction.** Postgres is the
  primary write; the refresh is a side effect. **Invalidation delivery is therefore
  best-effort in the MVP**: if Redis is down when the transaction runs, nothing
  retries it, and the user keeps their existing feed until TTL (bounded staleness,
  not permanent divergence — any later interaction that reaches Redis invalidates
  it). Production answer is a transactional outbox / durable event stream that
  retries until acknowledged, not one distributed transaction.
- **No synchronous fallback.** Miss → 202, cache down → 503. `service.ts` cannot
  reach the recommender, and a test makes the recommender throw to keep it that way.
- **Separate Redis client for the request path** (`cacheConnection`): BullMQ needs
  `maxRetriesPerRequest: null`, which would hang a GET instead of answering 503.
- **Refill is skipped for an empty generation or a reported candidate shortage** —
  otherwise every read queues another build forever.

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

`typecheck 0` · `lint 0` · `tests 364 passed, 5 skipped` across 28 files (with
`TEST_INTEGRATION=1`; without it the integration files skip themselves) · `check:env` in
sync at 78 keys · clean-bootstrap smoke over the documented README commands

**Do not run `npm run worker:feed` while the integration suite runs** — it drains the same
queue the tests assert on, and the failure looks like a broken epoch guard rather than an
environment problem.

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
| M4 | VLM analysis + model selection | **DONE** `6d48ed2` |
| M5 | user interactions + user profile | **DONE** `b889295` |
| M6 | candidate generation + ranking + diversity | **DONE** `1ace4e1` |
| M7 | feed serving + Redis cache + API | **DONE** `da96ac8` |
| **M8** | **demo + architecture + documentation** | **IN PROGRESS**, uncommitted |
| M8.4 | HOLDOUT-15 preparation | **NEXT after M8** |
| M8.5–M8.6 | VLM quality optimization, held-out eval | after MVP |
| M8.7 | learned-ranker readiness | optional |
| M9 | scraper | optional bonus |
| M10 | final polish, full clean-clone check, demo rehearsal | planned |

**M8.4 is next, and must not be started early.** No HOLDOUT labelling, no new VLM run,
no prompt v3, no Qwen3.5 — the held-out set is worth nothing the moment it leaks, and it
may be opened only after the configuration is frozen. Full protocol: [ROADMAP.md](ROADMAP.md).

**Serving semantics, restated so they are not re-litigated.** `GET /feed` is a Redis read
with **no** code path from an HTTP request to pgvector or to the ranker — not as a
fallback, not behind a flag. Feeds are filled by an event-driven rebuild, by a cache miss
and by refill.

> A cache miss answers **`202 building`** in the current MVP. Serving a miss from a
> precomputed global trending feed is a **future** degradation strategy for the 3k RPS
> design — `TRENDING_FEED_SIZE` and `TRENDING_FEED_REFRESH_SECONDS` exist in config and
> have no consumer. Earlier revisions of this file described it as if it were implemented.

M10 still owes a **full clean-clone check**: M8 ran a clean-bootstrap smoke over the
documented commands, which validates the M8 deliverable but is not the same as cloning
into an empty directory after every remaining milestone.
