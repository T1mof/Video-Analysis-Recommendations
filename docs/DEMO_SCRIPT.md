# Demo script — 10–15 minutes

A running order for a technical defence. Each block says what to show, what to say, and
what is actually on screen. It is a walkthrough of engineering decisions, not a pitch.

**Before you start:** [DEMO_CHEATSHEET.md](DEMO_CHEATSHEET.md) — three commands, then
`http://localhost:3000/demo`. Run `npm run demo:reset` right before presenting; it is
idempotent, so running it twice costs nothing and guarantees the state you rehearsed.

**Two windows:** the browser on `/demo`, and a terminal with the feed worker running so
its output is visible.

---

## 0–1 min · The problem, and the one constraint that shapes everything

> "Personalised feed for vertical short-form video. Four requirements: ingest 20–30
> videos, analyse them into features useful for recommendation, build a personalised
> algorithm, and design for 3,000 requests per second.
>
> The fourth one decides the other three. At 3k RPS you cannot rank on the request path —
> so recommendation happens in the background, and `GET /feed` is a Redis read. Everything
> else follows from that."

Show the top of [ARCHITECTURE.md](../ARCHITECTURE.md#1-current-mvp-architecture) — the
diagram with four separated lanes: offline analysis, online interaction, background
recommender, hot path.

Point at the dotted lines: **Postgres and pgvector are reached only from the worker.**

If asked "what would this look like in production?", scroll to the *second* diagram in
[section 16](../ARCHITECTURE.md#target-production-architecture-at-3k-feed-rps) — load
balancer, Fastify replicas, Kafka, ANN retrieval, GPU pool, CDN — every box dashed and
marked **TARGET / NOT IMPLEMENTED IN MVP**. Two diagrams on purpose: one is what runs,
one is what it grows into, and conflating them is how a design document starts lying.

---

## 1–3 min · Ingestion and video analysis

> "A vision model bills for pixels. Our corpus averages 33 seconds at 30 fps — about a
> thousand frames per video. We send **7.1**."

```
video → ffprobe → adaptive budget 6/8/12/16 by duration
      → ffmpeg extraction at ≤768 px → dHash near-duplicate removal
      → VLM → Zod validation → 110-dim vector → Postgres
```

Three points worth making, in this order:

1. **Adaptive, not fixed.** A 6-second clip and a 100-second one do not carry the same
   amount of distinct content.
2. **Closed taxonomy, not free tags.** 19 fields, a frozen 110-slot layout. The prompt is
   *generated from* the taxonomy, so the vocabulary cannot drift from what Zod enforces.
   Zero schema failures across the corpus.
3. **`unknown` encodes as zero.** Two videos whose hair colour is both undeterminable have
   nothing in common. Letting `unknown` match `unknown` would manufacture similarity out
   of missing information.

If asked why not send the whole video: **~139× more expensive on this corpus.** That is a
measured ratio, not a hand-wave.

---

## 3–5 min · From behaviour to a preference vector

Switch to the browser, **Alice** selected. Point at the profile panel.

```
profile = Σ(eventWeight × timeDecay × videoVector) / Σ|eventWeight × timeDecay|
decay   = 0.5 ^ (ageDays / halfLifeDays)          half-life 7 days
```

> "The profile lives in the *same* 110-dimension space as the videos, which is why the
> panel can name preferences instead of showing a similarity number."

Four decisions to call out:

- **Impressions weigh zero.** Scrolling past fifty videos leaves a user exactly as cold as
  they started. Being shown things is not liking them.
- **Negative dimensions are not clamped.** A profile that only accumulates positives
  cannot recover from a bad recommendation streak.
- **Normalised by Σ|signal|**, so a heavy and a light user with the same taste get
  comparable vectors, and repeating an interaction reinforces rather than inflates.
- **Creator affinity is a separate table, not a vector dimension.** "Which creators?" is an
  identity question, not a content one — folding it in would force a re-embed whenever the
  creator set changed.

Click **Bob**. Same corpus, opposite behaviour, visibly opposite preferences.

---

## 5–8 min · Candidate generation, ranking, diversity

> "Two stages, and they are separate modules because they fail differently."

Open **"why this video?"** on the top card. Everything below is on screen.

**Five sources**, each capped, union → dedupe → filter:
`similar` (pgvector cosine) · `tag` (jsonb + GIN) · `trending` (72h signed engagement) ·
`fresh` · `explore` (deterministic hash).

> "Multi-source is not only about quality. If the vector index degrades, four sources
> still return candidates — the feed gets worse rather than empty."

**Ranking** — read the bars off the panel:

```
score = 1.0×affinity + 0.15×quality + 0.2×freshness + 0.25×popularity
      − 0.35×fatigue + 0.1×exploration + 0.2×creatorAffinity
```

Say plainly: **these weights are heuristic priors, not trained coefficients.** There is no
production interaction dataset. Every feature and weighted term is recorded per item, so
the training data for a learned ranker is already being produced in the right shape.

**Diversity is a separate pass**, never folded into the score — plus two hard caps (2 per
creator, 3 sharing a tag in the top 10).

Worth a sentence, because it is the distinction people conflate:

> "Fatigue looks *backwards* at history. Diversity looks *sideways* within the list. A feed
> can be perfectly diverse and still be the fifth day running of the same creator — only
> fatigue catches that."

Then click **Carol**: `coldStart: true`. `similar` and `tag` are skipped entirely, affinity
is zeroed. A sparse profile is not a taste.

---

## 8–10 min · Live: the invalidation lifecycle

Back on **Alice**. Press **like** on the top card and narrate what appears in the log:

```
like recorded=true invalidated=true queued=true
new feed session
202 building        ← the API did not rank anything
generation replaced: 3f9c… → a17b…
```

> "One user action, four things: the event is durable in Postgres, the profile is rebuilt,
> the Redis epoch is bumped and the pointer dropped in **one MULTI/EXEC**, and a build is
> queued. Then the API answers 202 — it refuses to compute a feed on the request path even
> when the cache is empty."

Then press **Load more**: same `feedId`, next slice, no repeats.

> "Generations are immutable. A rebuild publishes a new feedId rather than editing the old
> one, so a cursor keeps reading the list it started on instead of having items shift
> underneath a scrolling client."

If someone asks about the explanation panel: it reads **one Redis key** written by the
worker at build time. It does not call the recommender — there is a test that makes the
recommender throw to prove it.

---

## 10–12 min · Serving, and the races that had to be handled

Show `docs/DEMO_CHEATSHEET.md` or run `npm run demo:feed` if there is time — it prints all
of this.

| Problem | Answer |
|---|---|
| Slow build overwrites a fresh one | Worker re-reads the epoch before publishing; a stale result is discarded |
| 100 simultaneous misses for one user | BullMQ deduplication keyed on user + epoch — one logical build |
| Epoch bumped but pointer survives a connection drop | Both in **one MULTI/EXEC** |
| Enqueue fails after invalidation | Invalidate *first*, queue second → a cache miss the next GET repairs, never a stale feed |
| Ten impressions from one screenful | `impression` records and marks seen, but does **not** invalidate |
| Rapid rebuilds accumulating in memory | At most 2 generations per user, evicted through an index list — never `KEYS`/`SCAN` |
| Redis down | **503**, no synchronous fallback — ranking inline during a cache outage turns a cache failure into a database stampede |

Measured locally: cache hit **mean 1.9 ms, p95 2.0 ms**; background build ~12 ms.

Then the honest line, before anyone asks:

> "That is one process on my machine. It says the hot path is a Redis read. It says nothing
> about 3,000 RPS — that is arithmetic in ARCHITECTURE.md §16, and it has not been load
> tested."

---

## 12–14 min · Model selection and cost

**Three models, one evaluation set, everything else held constant.**

| Metric | Qwen2.5-VL 3B | **Qwen3-VL 8B FP8** | InternVL3 8B |
|---|---:|---:|---:|
| Coverage | 100% | **100%** | 86.7% |
| Macro, end-to-end | 0.399 | **0.549** | 0.364 |
| Tokens per frame | 1,230 | **528** | 971 |

Two things to say here that matter more than the winner:

- **Coverage is reported because one model failed to answer at all, twice.** End-to-end
  scoring counts an unanalysable video as zero on every field — quoting valid-only scores
  across models with different coverage would reward the model that refused more videos.
- **A benchmark bug was found and it is in the document.** Under `--no-persist`, scoring
  fell back to the stored database row when a prediction was missing — so on the two videos
  InternVL3 failed, *Qwen3's* features were scored as InternVL3's. The incumbent inflated
  the challenger exactly where the challenger collapsed. The general lesson: an evaluation
  harness that can silently substitute one model's output for another's will always fail in
  the direction that hides the problem.

**Cost for 100,000 videos**, from measured `frames_used`, tokens and latency:

```
~264 GPU-hours  ≈  10,827 RUB      MEASURED rate, PROJECTED volume
```

- GPU inference dominates; preprocessing is two orders of magnitude cheaper — **that gap is
  the entire justification for adaptive sampling.**
- Frames are the lever: linear in frames, quadratic in edge length.
- One row in the cost model is a hypothetical 12× batching speed-up and is labelled as
  such. Every timing was taken at concurrency 1, so there is **no** measurement of batched
  throughput.

---

## 14–15 min · Limitations and what comes next

Lead with the limitations. It is the strongest part of the answer.

> "The 15 labelled videos have now scored three models, so 0.549 is a **fitted** number,
> not an independent one. The other 15 are reserved as a held-out set and **I have not
> opened them.** So I have no independent quality claim to make, and I would rather say
> that than quote a number that sounds better than it is."

Then, briefly:

- 30-video corpus; ranking weights are priors; `aestheticScore` is a model self-report.
- No load test at 3k RPS. No auth. Not deployed.
- Invalidation delivery is best-effort — bounded staleness, not a guarantee. The production
  answer is a transactional outbox.
- `video_stats` and `user_seen` are dead schema, found while writing the docs and recorded
  rather than quietly deleted.

**Next, in order:** label the held-out set → fix the pipeline before touching models
(`clothing` scores 0.07 on the selected model while a *weaker* model scores 0.31 on
identical frames — that is a prompt-mapping bug, not a capacity problem) → only then a
model sweep. Full protocol in [ROADMAP.md](ROADMAP.md).

> "The ordering is the point: starting with a model sweep would have paid for a bigger
> model to fix a prompt bug."
