# Demo cheatsheet

One page. Everything needed to start, reset, and recover in front of an audience.

---

## Start

```bash
docker compose up -d        # Postgres + pgvector, Redis, MinIO
npm run demo:reset          # deterministic scenario — idempotent, run it again any time
npm run dev:api             # terminal 1
npm run worker:feed         # terminal 2   ← without this every feed stays 202
```

**<http://localhost:3000/demo>**

If the pipeline has never been filled on this machine, do that first — see the README
Quick start:

```bash
npm run db:migrate
npm run ingest -- --mapping-out data/seed/mapping.json
npm run preprocess -- --all
npm run analyze -- --all --provider mock        # or a real provider
```

## Reset

```bash
npm run demo:reset
```

Rebuilds the Alice/Bob/Carol scenario from scratch, clears their cached feeds, and drops
pending build jobs. **Idempotent** — safe mid-demo, safe twice in a row. Run it
immediately before presenting.

It resets *demo users only*. It does not touch the corpus, features or vectors.

## Users

| User | State | What it demonstrates |
|---|---|---|
| `demo_alice` | warm, 25 interactions | Personalised ordering, positive and negative preferences |
| `demo_bob` | warm, mirror image | Same corpus, opposite behaviour, different feed |
| `demo_carol` | **cold start**, 3 effective signals | `similar`/`tag` skipped, global signals only |

Fixed UUIDs (from `scripts/seed-users.ts`):

```
alice  11111111-1111-4111-8111-111111111111
bob    22222222-2222-4222-8222-222222222222
carol  33333333-3333-4333-8333-333333333333
```

## Expected properties

Assert these out loud; they are what makes the demo a demonstration rather than a slideshow.

| Where | What must be true |
|---|---|
| Profile panel, Alice vs Bob | Different top preferences; overlapping dislikes inverted |
| Carol | `cold start` badge; candidate sources show `similar 0  tag 0` |
| Any card | "why this video?" lists sources and every weighted term |
| After `like` | `invalidated=true`, then `202 building`, then a **new feedId** |
| After a duplicate `eventId` | `recorded=false`, epoch unchanged, feed untouched |
| Load more | Same `feedId`, next ranks, **zero** repeated videos |
| Restart session | Starts at rank #1 of the current active generation |

## Scripted alternatives

```bash
npm run demo:profile -- --reset   # both profiles, decay and creator affinity, in the terminal
npm run demo:recommendations      # candidate counts, ranking breakdown, diversity
npm run demo:feed                 # the whole M7 lifecycle + measured latencies
```

`demo:feed` is the fallback if the browser misbehaves — it covers the same ground plus
build deduplication, impression semantics and generation retention.

---

## Troubleshooting

### Feed stays "Building recommendations…"

**The feed worker is not running.** It is the only thing that calls the recommender; the
API never builds a feed itself. The page says so after ~6 polls, and the warning appears
top-right.

```bash
npm run worker:feed
# expect: Feed worker started. concurrency=2, feed size=50, ttl=3600s
```

Still stuck? Check the queue is being drained and Redis is reachable:

```bash
curl localhost:3000/ready          # {"status":"ready","checks":{"redis":true,"postgres":true}}
docker compose ps                  # all three healthy
```

### Feed is empty (200, zero items)

The corpus is not analysed. An empty feed is a *valid* cached answer, so it will not retry.

```bash
npm run analyze -- --all --provider mock
npm run demo:reset
```

### `npm run demo:reset` says "No analysed videos with embeddings"

Expected on a clone with no corpus. The 18+ videos are not in the repository — put 20–30
vertical `.mp4` files in `data/seed/videos/` and run the ingest → preprocess → analyze
sequence above.

### Cards show "no media (metadata only)"

MinIO is down or the objects are missing. **The demo still works** — ranking, profiles and
explanations are metadata; only the thumbnails are gone.

```bash
docker compose up -d minio
```

### Cards say "explanations unavailable — FEED_DEBUG_SIDECAR is off"

The explanation sidecar is opt-in: it costs ~1.6 KB per item against the served feed's
96 B, so the code default is off and a production deployment writes none.

```bash
# .env
FEED_DEBUG_SIDECAR=true

npm run demo:reset        # the flag affects new builds; existing generations have none
```

Restart `worker:feed` after changing it — the flag is read at process start. Everything
else works with it off; only the "why this video?" panel is missing.

### Profile panel says "No profile yet"

The demo users are not seeded, or their UUIDs drifted from `scripts/seed-users.ts`.

```bash
npm run demo:reset
```

### Everything returns 503

Redis is down. **This is correct behaviour, and worth showing deliberately:**

```bash
docker compose stop redis
# GET /feed  →  503 feed_cache_unavailable
```

> The API refuses to rank inline during a cache outage. Recomputing feeds in the API
> process would turn a cache failure into a database stampede at the moment the system is
> least able to absorb one.

Note that `POST /interactions` **still succeeds** in this state: the event is durable in
Postgres and the response reports `feedInvalidated: false`. The interaction is the primary
write; the feed refresh is a side effect.

Recovery is automatic — no operator action, no manual rebuild:

```bash
docker compose start redis
npm run demo:reset          # only if you want the exact rehearsed state back
```

The first `GET /feed` after recovery sees no active pointer, answers 202 and queues the
build itself.

### Tests are failing for no reason

**Stop the feed worker.** It drains the same queue the integration suite asserts on.

```bash
TEST_INTEGRATION=1 npm test
```

### Windows: Ctrl+C leaves the process running

`SIGTERM` handlers do not run on Windows, so the graceful-shutdown path is POSIX-only.
Close the terminal or kill the process.

---

## Do not say

| Not this | This |
|---|---|
| "Tested at 3,000 RPS" | "Designed for 3,000 RPS; the arithmetic is in ARCHITECTURE §16, not load tested" |
| "Recommendation accuracy is 0.549" | "Tag macro on the development set is 0.549 — a *fitted* number" |
| "Qwen3 is the best model" | "The best of the three tested, on this taxonomy and this set" |
| "Production ready" | "MVP; no auth, no rate limiting, not deployed" |
| Quoting the 12× batching row | It is hypothetical and labelled so — every timing was at concurrency 1 |
