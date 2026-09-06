# Personalised feed for vertical short-form video

A one-week technical assignment: ingest vertical videos, analyse them with a vision
model into a closed taxonomy, build a personalised feed from real user behaviour, and
serve it at a shape that scales to ~3,000 requests per second.

The emphasis is on the recommendation design, the analysis cost model and the path to
high load — not on feature count.

```
video → sampled frames → VLM → taxonomy vector → user profile
      → 5 candidate sources → ranking → diversity → prepared feed → Redis → GET /feed
```

**Live demo:** `http://localhost:3000/demo` — one page, three users with genuinely
different feeds, an explanation for every item, and the invalidate → build → new
generation lifecycle visible as it happens.

---

## Architecture

Full design in **[ARCHITECTURE.md](ARCHITECTURE.md)**. The one decision that shapes
everything else:

```
GET /feed  →  Fastify  →  Redis  →  response          hot path,  ~2 ms measured locally

interaction / miss / refill  →  BullMQ  →  feed worker
       →  candidate generation → ranking → diversity  →  Redis      ~12 ms, off the request path
```

There is **no** code path from an HTTP request to Postgres, pgvector or the ranker — not
as a fallback, not behind a flag. It is enforced by what `src/feed/service.ts` imports,
and a test makes the recommender throw to keep it that way. Everything in the 3k RPS
design follows from that separation.

---

## Implemented MVP

| Area | What works today |
|---|---|
| **Ingestion** | ffprobe validation, sha256 dedupe, poster frame, MinIO + Postgres |
| **Preprocessing** | Adaptive frame budget 6/8/12/16 by duration, ffmpeg extraction, dHash near-duplicate removal |
| **Analysis** | `VisionProvider` abstraction, real Qwen3-VL-8B via vLLM, closed taxonomy v2 (19 fields), Zod validation, one repair retry, classified failures |
| **Benchmark** | 3 models on 15 hand-reviewed videos, coverage-aware scoring, per-field reports |
| **Cost model** | Generated from measured `frames_used` / tokens / latency, extrapolated to 100k |
| **Profile** | Signed, time-decayed preference vector + creator affinity + cold-start flag |
| **Recommender** | 5 candidate sources → filter → weighted ranking → diversity reranking |
| **Feed serving** | Immutable Redis generations, epoch invalidation, cursor pagination, background builds |
| **Demo UI** | One vanilla page at `/demo` with per-item explanations |

**Not implemented, and described in ARCHITECTURE.md instead:** Kafka/Redpanda,
ClickHouse, Redis Cluster, Kubernetes, CDN, HLS transcoding, a learned ranker, a
scraper, authentication.

---

## Quick start

### Requirements

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 24 | Everything (native `.env`, TS via `tsx`) |
| Docker + Compose | any current | Postgres + pgvector, Redis, MinIO |
| FFmpeg / FFprobe | 7+ | Ingestion and frame sampling — must be on `PATH` |
| NVIDIA GPU | 6 GB+ | *Optional.* Only for real VLM analysis |

Everything except the vision model runs without a GPU.

### 1. Services and schema

```bash
npm ci
cp .env.example .env          # defaults work as-is for local development

docker compose up -d          # Postgres + pgvector, Redis, MinIO
npm run db:migrate            # schema, pgvector extension, HNSW index
```

`db:migrate` verifies that the vector column dimension matches `TAXONOMY_DIM` in code and
refuses to continue if they have drifted.

Check it worked:

```bash
npm run check:env             # every key in .env.example is declared in env.ts
```

### 2. Add a corpus

> **The demo needs video files, and they are not in this repository.** The 18+ source
> corpus is local-only and never redistributed. Put 20–30 vertical `.mp4` files in
> `data/seed/videos/`, or point `DEMO_SOURCE_DIR` elsewhere.
>
> Without a corpus the API, `/demo`, `/health` and the test suite all still run — but
> every feed is empty, and `npm run demo:reset` stops with *"No analysed videos with
> embeddings"*. That is expected, not a broken clone.

Optionally add `data/seed/manifest.json` to attach creator attribution — see
[data/seed/README.md](data/seed/README.md). Without it creator fields are `null`, which
the system handles.

### 3. Fill the pipeline

```bash
npm run ingest -- --mapping-out data/seed/mapping.json   # validate, dedupe, upload
npm run preprocess -- --all                              # sample frames, no model
npm run analyze -- --all --provider mock                 # synthetic features, no GPU
```

Swap step three for a real model when you have one — see [Real VLM
analysis](#real-vlm-analysis).

### 4. Run the demo

```bash
npm run demo:reset       # deterministic scenario: Alice, Bob, Carol
npm run dev:api          # terminal 1
npm run worker:feed      # terminal 2  ← without this every feed stays 202
```

Open **<http://localhost:3000/demo>**.

The feed worker is a separate process on purpose: it is the only thing that calls the
recommender. If it is not running, the API keeps answering `202 building` — and the demo
page says so after a few polls rather than spinning forever.

---

## Demo

Two ways in.

### The page

`http://localhost:3000/demo` — user selector, live profile, feed, and an expandable
explanation per card.

| What to look at | Why it matters |
|---|---|
| Switch Alice → Bob | Same corpus, opposite behaviour, different ordering |
| Carol | `coldStart: true` — no `similar`/`tag` sources, global signals only |
| "why this video?" | Candidate sources and every weighted term of the score |
| Press `like` | `feedInvalidated: true` → `202 building` → new `feedId` |
| Load more | Cursor pagination inside one immutable generation, no repeats |

The page is a client of the ordinary API. The only demo-specific endpoint is
`GET /demo/api/feed-debug`, which reads one Redis key and imports neither the recommender
nor any database module. **Demo endpoints are local demonstration surfaces, not production
API.**

> **Explanations are opt-in.** They come from a per-generation sidecar measured at ~1.6 KB
> per item against the served feed's 96 B — about 17×, which is a demo cost and not one a
> production feed cache should pay. The code default is **off**; `.env.example` enables it
> because that file *is* the local demo configuration. With it off everything else works
> unchanged and the page says explanations are unavailable.
>
> If you copied `.env` before this existed, add `FEED_DEBUG_SIDECAR=true` and rebuild the
> feed (`npm run demo:reset`) — `npm run check:env` will tell you if the two files have
> drifted.

### Scripted walkthroughs

```bash
npm run demo:profile -- --reset   # two users react oppositely; prints both profiles
npm run demo:recommendations      # candidate sources, ranking, diversity, per-item scores
npm run demo:feed                 # full M7 lifecycle over HTTP, including latencies
```

`demo:feed` covers what the page does not show conveniently: build deduplication,
impressions *not* forcing a rebuild, generation retention under rapid rebuilds, and
measured cache-hit latency.

Presentation running order: **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)**.
Commands and troubleshooting on one page: **[docs/DEMO_CHEATSHEET.md](docs/DEMO_CHEATSHEET.md)**.

---

## API

```bash
npm run dev:api
```

| Route | Purpose |
|---|---|
| `GET /feed?userId=&limit=&cursor=` | The feed. Redis only |
| `POST /interactions` | Record one interaction; `eventId` makes retries idempotent |
| `GET /users/:userId/profile` | Cold-start status, top likes and dislikes, creator affinity |
| `GET /signals` | Event weights, half-life and cold-start threshold in force |
| `GET /health` | Liveness plus the taxonomy version the process was built against |
| `GET /ready` | Readiness — reports Redis and Postgres separately |
| `GET /demo` | Demo page *(demonstration surface, not production API)* |
| `GET /demo/api/feed-debug?userId=&feedId=` | Stored explanation for one generation *(same)* |

```bash
curl "localhost:3000/feed?userId=<uuid>&limit=10"

curl -X POST localhost:3000/interactions -H 'content-type: application/json' \
  -d '{"eventId":"evt-1","userId":"<uuid>","videoId":"<uuid>","type":"like","watchRatio":0.9}'
```

### Feed responses

| Status | Meaning |
|---|---|
| `200` | Served from cache |
| `202` | No feed yet — a build was queued; retry shortly |
| `400` | Bad request, or a cursor that is malformed or belongs to another user |
| `404` | Unknown user |
| `410` | Cursor valid but its generation expired — start a new session |
| `503` | Feed cache unavailable |

A cache miss returns `202`, never a synchronously computed feed: recomputing in the API
during a Redis outage turns a cache failure into a database stampede.

Feeds are **immutable generations** behind an active pointer — a rebuild publishes a new
`feedId` rather than editing the old one, so a cursor keeps reading the list it started
on. At most two generations are kept per user.

A preference-changing interaction (`view`, `complete`, `like`, `skip`, `dislike`) bumps
the epoch, drops the pointer and queues a rebuild. An `impression` is recorded and makes
the video "seen" for the *next* build, but does not force one — ten impressions from one
screenful would otherwise mean ten rebuilds. Duplicates change nothing.

---

## Recommendation algorithm

Two stages, kept separate because they fail differently.

**1. Candidate generation** — five independent sources, each capped, union → dedupe →
filter. A video found by several sources appears once and carries all of them.

| Source | How it retrieves |
|---|---|
| `similar` | pgvector cosine between profile vector and video vectors |
| `tag` | jsonb lookup on the user's strongest preferred taxonomy values (GIN index) |
| `trending` | signed engagement in a 72-hour window |
| `fresh` | newest analysed videos |
| `explore` | deterministic hash of `userId + videoId + UTC day` |

Multi-source is not only about quality: if the vector index degrades, four sources still
return candidates and the feed gets worse rather than empty.

**2. Ranking, then diversity as a separate pass**

```
score  = 1.0×affinity + 0.15×quality + 0.2×freshness + 0.25×popularity
       − 0.35×fatigue + 0.1×exploration + 0.2×creatorAffinity

rerank = score − 0.3 × max(0, maxCosineToSelected)
```

plus two hard caps: at most 2 videos per creator, at most 3 sharing a meaningful tag in
the top 10.

**The user profile** those scores are computed against:

```
profile = Σ(eventWeight × timeDecay × videoVector) / Σ|eventWeight × timeDecay|
decay   = 0.5 ^ (ageDays / halfLifeDays)          half-life 7 days
cold    = effectiveSignalCount < 5
```

Negative dimensions are not clamped — a profile that can only accumulate positives cannot
recover from a bad recommendation streak.

> **Ranking weights are heuristic priors, not trained coefficients.** There is no
> production interaction dataset to learn from. Every feature and weighted term is
> recorded per item, so the training data for a learned ranker is already produced in the
> right shape. See ARCHITECTURE.md §17.

---

## VLM model selection

Three models, one evaluation set, everything else held constant — same taxonomy, same
prompt, same sampler, same 768 px frames, same 15 hand-reviewed videos.

| Metric | Qwen2.5-VL 3B | **Qwen3-VL 8B FP8** | InternVL3 8B BF16 |
|---|---:|---:|---:|
| Coverage (valid output) | 100% | **100%** | 86.7% |
| Macro, end-to-end | 0.399 | **0.549** | 0.364 |
| single / multi | 0.383 / 0.485 | **0.517 / 0.722** | 0.329 / 0.548 |
| Input tokens per frame | 1,230 | **528** | 971 |
| Schema failures | 0 | **0** | 2 |

**Selected: `Qwen/Qwen3-VL-8B-Instruct-FP8`**, served by vLLM.

*End-to-end* scores a video the model could not answer as 0 on every field — which is what
a pipeline actually experiences. Quoting valid-only scores across models with different
coverage would reward the model that refused more videos.

> **These 15 videos are a development set (DEV-15), not an independent measure.** They
> have scored three models and informed error analysis, so any number quoted against them
> is fitted. The remaining 15 are reserved as HOLDOUT-15 and **have not been labelled or
> opened.** There is currently no independent quality claim to make.

Reports: [MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md) ·
[BENCHMARK-qwen3vl-8b-rented.md](docs/BENCHMARK-qwen3vl-8b-rented.md) ·
[BENCHMARK-qwen2.5vl-3b-local.md](docs/BENCHMARK-qwen2.5vl-3b-local.md)

### Real VLM analysis

Any server speaking the OpenAI `/v1/chat/completions` shape with image content parts
works: Ollama, llama.cpp, vLLM, LM Studio, or a hosted endpoint. Point `VISION_BASE_URL`
at it — there is no separate code path for rented hardware.

```bash
# .env
VISION_PROVIDER=openai-compatible
VISION_BASE_URL=http://localhost:11434/v1
VISION_MODEL=qwen2.5vl-3b-16k
ANALYSIS_CONCURRENCY=1        # VRAM-bound, not CPU-bound

npm run analyze -- --all --provider openai-compatible --force
npm run bench-vlm -- --out docs/BENCHMARK-<model>.md
```

<details>
<summary>Local Ollama, and the two things that will bite you</summary>

```bash
ollama pull qwen2.5vl:3b
ollama create qwen2.5vl-3b-16k -f ollama/Modelfile.qwen2.5vl-3b-16k
```

The custom Modelfile is **required**, not cosmetic: Ollama defaults this model to a
4,096-token context, and one video's frames measured 7,655–15,200 tokens. The default
fails with `exceed_context_size_error`. The Modelfile raises it to 16,384 and pins
`temperature 0`.

**Keep `ANALYSIS_CONCURRENCY=1` on a 6 GB card.** The model plus a 16k KV cache occupies
~4.7 GB, and a second concurrent inference does not fit. A 24 GB card takes 2–4.

</details>

<details>
<summary>Rented GPU over an SSH tunnel</summary>

Serve on **loopback only** so the endpoint is never exposed publicly:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model <model> --host 127.0.0.1 --port 8000 \
  --max-model-len 24576 \
  --limit-mm-per-prompt '{"image": 16}' \
  --gpu-memory-utilization 0.90
```

`--limit-mm-per-prompt` is not optional: vLLM accepts **one** image per prompt by default
and silently drops the rest, which looks like a model that cannot see the video rather
than a configuration mistake. It must be at least `MAX_ANALYSIS_FRAMES`.

```bash
ssh -N -L 8000:127.0.0.1:8000 <user>@<host> -p <port>
npm run analyze -- --all --provider openai-compatible --force \
  --base-url http://127.0.0.1:8000/v1 --model <served-model-name>
```

**Match the CUDA build to the host driver.** Installing the newest vLLM pulls a torch
built for the newest CUDA; if the host driver is an older *major* version, torch reports
no GPU at all and the failure looks like a broken install.

Put credentials in `.env`, which is gitignored. Never commit an API key.

</details>

**Check the provider's content policy first.** A general-purpose hosted API may refuse
explicit adult material outright, which is the main reason this design targets
self-hosting.

### The mock provider is synthetic

`--provider mock` fabricates features from a hash of the video id. It never looks at a
pixel. Every CLI surface prints a warning, `modelVersion` is `synthetic-archetype-v1`, and
each caption is prefixed `[SYNTHETIC - not real analysis]`. It exists so the pipeline,
tests and recommender run with no GPU. **Never present its output as analysis.**

---

## Cost

Full model, regenerated from measured data by `npm run cost-model`:
**[docs/COST_MODEL.md](docs/COST_MODEL.md)**. Every row is labelled MEASURED, ASSUMED or
DERIVED.

**Analysing 100,000 videos** at the measured 9.5 s/video on a rented RTX 4090:

```
~264 GPU-hours  ≈  10,827 RUB     (MEASURED rate 41.06 RUB/h, PROJECTED volume)
```

| Line item | Cost |
|---|---|
| GPU inference | 10,827 RUB one-off |
| Preprocessing CPU, 22 core-hours | $0.87 one-off (ASSUMED rate) |
| Object storage, 558 GB | $12.84/month (ASSUMED rate) |
| Database + vectors, 0.27 GB | negligible |

Currencies are not summed: the GPU line is a measured RUB invoice, the rest are assumed
USD list prices, and no exchange rate has been supplied.

**The shape matters more than the number:**

- **GPU inference dominates.** Preprocessing is two orders of magnitude cheaper — that gap
  is the entire justification for adaptive sampling.
- **Frames are the lever.** Cost is linear in frames, quadratic in frame edge length.
  Dropping `FRAME_MAX_LONG_EDGE` 768 → 512 cuts tokens per frame ~55%.
- **Sending whole videos is ~139× more expensive.** Not a near miss.

The corpus averages 32.7 s at ~30 fps — about 1,000 frames per video. The pipeline sends
**7.1**.

---

## Scale

Designed for ~3,000 RPS on `GET /feed`; **not load-tested.** Arithmetic and assumptions in
[ARCHITECTURE.md §16](ARCHITECTURE.md#16-production-evolution-and-3000-rps).

| Quantity | Result |
|---|---|
| Redis ops at 3k RPS | ~6,000/s — **~6% of one node** |
| API JSON egress | ~48 Mbit/s |
| **Media egress at peak** | **~90 Gbps — served by a CDN, never by the API** |
| Feed rebuilds at peak | ~310/s → **~16 workers** |
| API pods | 3–4 for redundancy, 6–10 for 2–3× headroom |

The single most important number is the last-but-two: media delivery dominates everything
else by four orders of magnitude, which is exactly why `videos.s3Key` is presigned rather
than proxied from the first milestone onward.

Measured locally, one process, 30 videos: cache hit **mean 1.9 ms / p95 2.0 ms**, cold miss
(enqueue only) 2.7 ms, background build ~12 ms.

---

## Limitations

The honest list. Full version in
[ARCHITECTURE.md §15](ARCHITECTURE.md#15-current-mvp-limitations).

- **30-video corpus.** Every recommendation figure is measured on it.
- **DEV-15 is burned** — it scored three models, so its 0.549 is a fitted number.
  **HOLDOUT-15 has not been opened**, so there is no independent quality measure.
- **Ranking weights are heuristic priors.** No learned ranker, no real interaction logs.
- **`aestheticScore` is a model self-report**, never validated against gold.
- **No load test at 3k RPS.** Design and arithmetic only.
- **Invalidation delivery is best-effort** — if Redis is down when an interaction commits,
  nothing retries it. Bounded staleness, not a guarantee.
- **No auth, no rate limiting.** Any caller may post an interaction for any user id.
- **Demo endpoints are mounted unconditionally**, including in production mode.
- **`video_stats` and `user_seen` are dead schema** — declared, never read or written.
- **Graceful shutdown is POSIX-only**; `SIGTERM` handlers do not run on Windows.
- **Not deployed anywhere.** Docker Compose locally, no hosted environment.

---

## Tests

```bash
npm run typecheck
npm run lint
npm test                      # unit tests, no services required

TEST_INTEGRATION=1 npm test   # adds tests against real Postgres, Redis and MinIO
```

Integration tests generate their own ffmpeg fixtures and clean up every row and object
they create. Tests requiring ffmpeg skip themselves when it is absent. They run one file
at a time (`fileParallelism: false`): they share one Postgres, and trending popularity is a
global aggregate, so a concurrent file inserting events would change what another is
measuring.

**Do not run `npm run worker:feed` while the integration suite runs** — it drains the same
queue the tests assert on.

---

## Configuration

Defaults in `.env.example` work for local development. The ones that actually change
behaviour:

| Variable | Default | What it controls |
|---|---|---|
| `DATABASE_URL` / `REDIS_URL` | local | Connections |
| `S3_ENDPOINT` / `S3_BUCKET` | MinIO | Object storage |
| `VISION_PROVIDER` | `mock` | `mock` or `openai-compatible` |
| `VISION_BASE_URL` / `VISION_MODEL` | Ollama defaults | Any OpenAI-compatible server |
| `ANALYSIS_CONCURRENCY` | `1` | **VRAM-bound.** Raise only on a bigger card |
| `FRAMES_TIER_*`, `MAX_ANALYSIS_FRAMES` | 6/8/12/16, cap 16 | **The primary cost lever** |
| `FRAME_MAX_LONG_EDGE` | `768` | Tokens scale with pixels |
| `PROFILE_HALFLIFE_DAYS` | `7` | Preference decay |
| `COLD_START_MIN_INTERACTIONS` | `5` | Cold-start threshold |
| `RANK_W_*` | see table above | Ranking weights |
| `FEED_SIZE` / `FEED_TTL_SECONDS` | 50 / 3600 | Generation size and lifetime |
| `FEED_DEBUG_SIDECAR` | `false` in code, `true` in `.env.example` | Per-generation explanations for `/demo`. ~17× the served payload per item, so **opt-in** |

`npm run check:env` fails if `.env.example` and `src/config/env.ts` disagree.

---

## Roadmap

Milestone status and the deferred quality work: **[docs/ROADMAP.md](docs/ROADMAP.md)**.

| | | |
|---|---|---|
| M0–M3 | Infrastructure, taxonomy v2, ingestion, DEV-15, preprocessing | **done** |
| M4 | VLM analysis + model selection | **done** |
| M5 | User interactions + preference profile | **done** |
| M6 | Candidate generation + ranking + diversity | **done** |
| M7 | Feed serving + Redis cache + API | **done** |
| M8 | Demo UI + architecture + documentation | **done** |
| M8.4–M8.6 | HOLDOUT-15 preparation, VLM quality optimisation, held-out evaluation | next |
| M8.7 | Learned-ranker readiness | optional |
| M9 | Scraper | optional bonus |

---

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full design: overview, ingestion, analysis, database model, recommender, feed, failure handling, cost, 3k RPS, tradeoffs |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | 10–15 minute presentation running order |
| [docs/DEMO_CHEATSHEET.md](docs/DEMO_CHEATSHEET.md) | Commands, expected output, troubleshooting |
| [docs/COST_MODEL.md](docs/COST_MODEL.md) | Cost of analysing 100k videos, from measurements |
| [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md) | Three models, selection, and a benchmark bug worth reading about |
| [docs/BENCHMARK-qwen3vl-8b-rented.md](docs/BENCHMARK-qwen3vl-8b-rented.md) | Selected model, per-field report against DEV-15 |
| [docs/BENCHMARK-qwen2.5vl-3b-local.md](docs/BENCHMARK-qwen2.5vl-3b-local.md) | Local 3B baseline, same set |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and deferred quality work |
| [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) | Decisions and their reasoning |
| [data/gold/README.md](data/gold/README.md) | How the hand-reviewed benchmark set was produced |
| [data/seed/README.md](data/seed/README.md) | Corpus conventions; why demo creators are synthetic |
