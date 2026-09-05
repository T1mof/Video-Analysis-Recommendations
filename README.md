# Video Analysis & Recommendations

A personalised feed for vertical short-form video, built as a one-week technical
assignment. The emphasis is on the recommendation design, the video-analysis cost
model and the path to high load — not on feature count.

**What works today:** local corpus ingestion → adaptive frame sampling → real
vision-model analysis into a closed taxonomy → 110-dimension content vectors in
pgvector → user interactions into a signed, time-decayed preference profile with
creator affinity. Candidate generation, ranking, the feed API and the demo UI are
the next milestones.

---

## How it works

```
data/seed/videos/*.mp4
      │
      ▼
INGEST      ffprobe validate → sha256 dedupe → poster frame
            → MinIO + Postgres row (status=ingested)
      │
      ▼
PREPROCESS  adaptive frame budget (6/8/12/16 by duration)
            → ffmpeg extraction → dHash near-duplicate removal
            → a handful of representative frames (temporary)
      │
      ▼
ANALYZE     VisionProvider → closed taxonomy v2 → Zod validation
            → 110-dim vector → Postgres transaction (status=analyzed)
      │
      ▼
[next]      user profile → candidates → ranking → Redis feed → API + UI
```

The design decision that drives everything: **the model never sees the whole
video.** It sees 6–16 sampled, de-duplicated frames. Cost scales with frames ×
pixels, so that choice is the difference between an affordable pipeline and an
unaffordable one — see [docs/COST_MODEL.md](docs/COST_MODEL.md).

---

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 24 LTS | Uses native `.env` loading and TS type-stripping via `tsx` |
| Docker + Compose | any current | Postgres, Redis, MinIO |
| FFmpeg / FFprobe | 7+ | Must be on `PATH` |
| Ollama *(optional)* | any current | Only needed for real VLM analysis |
| NVIDIA GPU *(optional)* | 6 GB+ | Only needed for real VLM analysis |

Everything except the vision model runs without a GPU. The pipeline ships a
deterministic mock provider so the whole system is exercisable on any machine.

---

## Setup

```bash
git clone <repo> && cd video-recommendation
npm install
cp .env.example .env          # defaults work as-is for local development

docker compose up -d          # Postgres + pgvector, Redis, MinIO
npm run db:migrate            # schema + pgvector extension + HNSW index
```

`db:migrate` verifies that the vector column dimension matches `TAXONOMY_DIM` in
code and refuses to continue if they have drifted.

### Add a corpus

The 18+ source videos are **not** in this repository. Put 20–30 vertical `.mp4`
files in `data/seed/videos/`, or point `DEMO_SOURCE_DIR` elsewhere.

Optionally add `data/seed/manifest.json` to attach creator attribution — see
[data/seed/README.md](data/seed/README.md). Without it, creator fields are `null`,
which the system handles.

---

## Running the pipeline

```bash
# 1. Ingest: validate, deduplicate, upload to MinIO, write metadata
npm run ingest -- --mapping-out data/seed/mapping.json

# 2. Preprocess: sample frames (no model involved)
npm run preprocess -- --all
npm run preprocess -- --external-id video_20 --contact-sheet   # visual check

# 3. Analyze with the synthetic mock (no GPU needed)
npm run analyze -- --all --provider mock

# 3b. Analyze with a real vision model (see below)
npm run analyze -- --all --provider openai-compatible --force

# 4. Benchmark the model against the hand-reviewed gold set
npm run bench-vlm -- --out docs/BENCHMARK.md

# 5. Regenerate the cost model from measured data
npm run cost-model
```

Add `--help` to any of these for the full flag list.

### The mock provider is synthetic

`--provider mock` fabricates features from a hash of the video id. It never looks
at a pixel, and a video's mock tags will often contradict its real content. Every
CLI surface prints a warning, `modelVersion` is `synthetic-archetype-v1`, and each
caption is prefixed `[SYNTHETIC - not real analysis]`.

It exists so the pipeline, tests and downstream recommender can run with no GPU.
Never present its output as analysis.

---

## Real VLM analysis

Any server speaking the OpenAI `/v1/chat/completions` shape with image content
parts works: Ollama, llama.cpp, vLLM, LM Studio, or a hosted endpoint. Point
`VISION_BASE_URL` at it.

### Local, via Ollama

```bash
ollama pull qwen2.5vl:3b
ollama create qwen2.5vl-3b-16k -f ollama/Modelfile.qwen2.5vl-3b-16k
```

The custom Modelfile is **required**, not cosmetic: Ollama defaults this model to a
4,096-token context, and one video's frames measured 7,655–15,200 tokens. The
default context fails with `exceed_context_size_error`. The Modelfile raises it to
16,384 and pins `temperature 0` for reproducibility.

Then:

```bash
# .env
VISION_PROVIDER=openai-compatible
VISION_BASE_URL=http://localhost:11434/v1
VISION_MODEL=qwen2.5vl-3b-16k
VISION_MODEL_VERSION=ollama-q4-16k
ANALYSIS_CONCURRENCY=1        # see below
```

```bash
npm run analyze -- --external-id video_14 --provider openai-compatible --force
```

**Keep `ANALYSIS_CONCURRENCY=1` on a 6 GB card.** Concurrency here is bounded by
VRAM, not CPU: the model plus a 16k KV cache occupies ~4.7 GB of a 6 GB card, and a
second concurrent inference does not fit. A 24 GB A10/L4 comfortably takes 2–4.

### Rented or hosted GPU

The architecture does not change: stand up any OpenAI-compatible server (vLLM
serves one directly) and repoint `VISION_BASE_URL`. There is no separate code path
for rented hardware.

On the GPU host, serve on **loopback only** so the endpoint is never exposed
publicly:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model <model> --host 127.0.0.1 --port 8000 \
  --max-model-len 24576 \
  --limit-mm-per-prompt '{"image": 16}' \
  --gpu-memory-utilization 0.90
```

`--limit-mm-per-prompt` is not optional: vLLM accepts **one** image per prompt by
default and silently drops the rest, which looks like a model that cannot see the
video rather than a configuration mistake. It must be at least
`MAX_ANALYSIS_FRAMES`.

From the workstation, open a tunnel and point the tools at it:

```bash
ssh -N -L 8000:127.0.0.1:8000 <user>@<host> -p <port>

npm run analyze -- --all --provider openai-compatible --force \
  --base-url http://127.0.0.1:8000/v1 --model <served-model-name>
```

`--base-url`, `--model` and `--model-version` are also accepted by
`npm run bench-vlm`, so a second model can be benchmarked without editing `.env`.

**Match the CUDA build to the host driver.** Installing the newest vLLM pulls a
torch built for the newest CUDA; if the host driver is older *major* CUDA version,
torch reports no GPU at all and the failure looks like a broken install. Check
`nvidia-smi` for the driver version first and pin a vLLM release whose torch
targets that CUDA major version.

Put credentials in `.env`, which is gitignored. Never commit an API key.

**Check the provider's content policy first.** A general-purpose hosted API may
refuse explicit adult material outright, which is the main reason this design
targets self-hosting.

---

## User profiles

Interactions become a signed, time-decayed preference vector in the same
110-dimension space as the videos, plus a per-creator affinity score.

```bash
npm run seed                    # two demo users, plus one deliberately cold
npm run demo:profile -- --reset # deterministic scenario, prints the profiles
```

The demo has two users react to the *same* corpus in opposite ways and shows the
resulting preferences, dislikes, creator affinity and cold-start status:

```
demo_alice
  interactions 24   effective 12   cold start: no
  likes     explicitness:suggestive  0.097   actType:talking  0.092
  dislikes  explicitness:explicit   -0.075   cameraStyle:pov -0.049
  creator   demo_creator_01  0.376      demo_creator_09  -0.341
```

The formula, and why negative preferences and time decay both matter, is in
[ARCHITECTURE.md](ARCHITECTURE.md#user-interactions-and-the-preference-profile):

```
profile = Σ(eventWeight × timeDecay × videoVector) / Σ|eventWeight × timeDecay|
decay   = 0.5 ^ (ageDays / halfLifeDays)
```

### Interaction API

```bash
npm run dev:api
```

| Route | Purpose |
|---|---|
| `POST /interactions` | Record one interaction; `eventId` makes retries idempotent |
| `GET /users/:userId/profile` | Cold-start status, top likes and dislikes, creator affinity |
| `GET /signals` | The event weights, half-life and cold-start threshold in force |
| `GET /health` | Liveness plus the taxonomy version the process was built against |

```bash
curl -X POST localhost:3000/interactions -H 'content-type: application/json' \
  -d '{"eventId":"evt-1","userId":"<uuid>","videoId":"<uuid>","type":"like","watchRatio":0.9}'

curl localhost:3000/users/<uuid>/profile
```

`GET /feed` deliberately does not exist yet — it is M7, and it must be a Redis read
rather than anything that recomputes recommendations per request.

---

## Recommendations

Five candidate sources → union → dedupe → filter → weighted ranking → diversity
reranking → an ordered list, with a full score breakdown per item.

```bash
npm run demo:recommendations
```

Alice and Bob reacted to the same corpus in opposite ways, so their orderings
diverge; Carol is cold-start and is served global signals only:

```
demo_alice   cold start: no    candidates: similar 18  tag 14  trending 3 … → 18 unique
  1  video_15  demo_creator_05  similar,tag,trending,fresh   base 0.554  final 0.554
        + popularity +0.250, freshness +0.183, affinity +0.129
        - fatigue -0.146

demo_carol   cold start: YES   candidates: similar 0  tag 0  trending 6  fresh 27 …
```

`video_25` is Bob's top recommendation and Alice's tenth — she is measurably
negative on it (`affinity −0.201`). That divergence is the whole point.

```
score = 1.0×affinity + 0.15×quality + 0.2×freshness + 0.25×popularity
      − 0.35×fatigue + 0.1×exploration + 0.2×creatorAffinity
```

Weights are heuristic priors — there is no interaction dataset to learn them from
yet. Full reasoning, feature ranges and the diversity rules are in
[ARCHITECTURE.md](ARCHITECTURE.md#candidate-generation-ranking-and-diversity).

---

## Background workers

```bash
npm run dev:worker     # drains the analysis queue
```

Ingestion does **not** enqueue analysis by default — pass `--enqueue` if you want
it to. The two stages are decoupled so a slow or offline model never blocks getting
content into the system.

---

## Tests

```bash
npm run typecheck
npm run lint
npm test                      # unit tests, no services required

TEST_INTEGRATION=1 npm test   # adds tests against real Postgres/MinIO
```

Integration tests generate their own ffmpeg fixtures and clean up every row and
object they create. Tests requiring ffmpeg skip themselves when it is absent.

---

## Required environment variables

Defaults in `.env.example` work for local development; copy it and adjust. The ones
that actually change behaviour:

| Variable | Default | What it controls |
|---|---|---|
| `DATABASE_URL` | local Postgres | Connection string |
| `REDIS_URL` | local Redis | Queues and (later) feed cache |
| `S3_ENDPOINT` / `S3_BUCKET` | MinIO | Object storage |
| `VISION_PROVIDER` | `mock` | `mock` or `openai-compatible` |
| `VISION_BASE_URL` | Ollama default | Any OpenAI-compatible server |
| `VISION_MODEL` | `qwen2.5vl-3b-16k` | Model name as the backend knows it |
| `ANALYSIS_CONCURRENCY` | `1` | **VRAM-bound.** Raise only on a bigger card |
| `FRAMES_TIER_*`, `MAX_ANALYSIS_FRAMES` | 6/8/12/16, cap 16 | The primary cost lever |
| `FRAME_MAX_LONG_EDGE` | `768` | Tokens scale with pixels |
| `DEDUP_HAMMING_THRESHOLD` | `6` | Near-duplicate aggressiveness |

Every knob affecting analysis cost or ranking is in `.env.example` with a comment.

---

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Feature model, taxonomy versioning, video analysis, feed serving, 3k RPS arithmetic |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestone status, and the quality work deferred until after the MVP |
| [docs/COST_MODEL.md](docs/COST_MODEL.md) | Cost of analysing 100k videos, generated from measurements |
| [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md) | Three models on the same set: selection, coverage, and a benchmark bug |
| [docs/BENCHMARK-qwen3vl-8b-rented.md](docs/BENCHMARK-qwen3vl-8b-rented.md) | Selected model's per-field report against DEV-15 |
| [docs/BENCHMARK-qwen2.5vl-3b-local.md](docs/BENCHMARK-qwen2.5vl-3b-local.md) | Local 3B baseline, same set |
| [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) | Decisions and their reasoning |
| [data/gold/README.md](data/gold/README.md) | How the hand-reviewed benchmark set was produced |
| [data/seed/README.md](data/seed/README.md) | Corpus conventions; why demo creators are synthetic |

---

## Scope

Not implemented, and described in ARCHITECTURE.md instead: Kafka, ClickHouse, Redis
Cluster, Kubernetes, CDN, HLS transcoding, a learned ranker.

A Fansly/Fanvue scraper is an optional bonus scheduled after the core is complete.
The assignment permits content from any source, so the demo runs on a local corpus
rather than depending on a third-party site being reachable at demo time.
