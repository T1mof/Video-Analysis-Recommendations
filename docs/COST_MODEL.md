# Cost model: analysing 100,000 videos

Generated from measured data by `npm run cost-model`.
Corpus measured: **30 videos**, model `qwen3-vl-8b-fp8` (vllm-0.11.0-fp8).

Every row is tagged:

- **MEASURED** — observed on this corpus and hardware.
- **ASSUMED** — a price or ratio taken from a vendor or a judgement call. Configurable in `.env`.
- **DERIVED** — computed from the two above.

The headline: at the measured rate, GPU inference dominates. Everything else —
preprocessing, storage, vectors — is a rounding error against it.

---

## 1. Measured inputs

| Quantity | Value | Source |
|---|---|---|
| Videos analysed | 30 | MEASURED |
| Frames per video (mean) | 7.1 | MEASURED — adaptive sampling, cap 16 |
| Input tokens per video (mean) | 3804 | MEASURED (n=30) |
| Output tokens per video (mean) | 443 | MEASURED (n=30) |
| Tokens per frame | 538 | DERIVED — at `FRAME_MAX_LONG_EDGE=768` |
| Inference latency, mean | 9.5 s | MEASURED — **full-corpus-30**, concurrency 1 |
| Inference latency, p95 | 10.5 s | MEASURED — full-corpus-30 |
| Preprocessing wall clock | 0.786 s | MEASURED at M3 |
| Average video size | 5.7 MB | MEASURED |
| Average duration | 32.7 s | MEASURED |

**Which latency sample.** The figures above are the **full-corpus-30 mean and p95**,
not the gold-15 benchmark mean (9.7 s for the 8B).
The 30-video sample is used for extrapolation because it spans the corpus's actual
duration distribution, and duration determines the frame budget, which determines
inference time. The 15-video gold subset is selected for taxonomy coverage rather
than duration coverage, so its mean is not representative of a bulk run.

**Concurrency caveat.** All timings were taken at `ANALYSIS_CONCURRENCY=1`. Nothing
here measures batched throughput.

---

## 2. GPU inference — self-hosted

Formula:

```
gpu_hours = 100,000 x seconds_per_video / 3600
cost      = gpu_hours x hourly_rate
```

At the **actually paid** rate of `COST_GPU_HOURLY_RUB=41.06` RUB/hour
(MEASURED — invoice rate for the rented RTX 4090):

Two scenarios below are computed from measured per-video latency. The third is not
a measurement and is kept visually separate for that reason.

| Scenario | Provenance | Input | Formula | GPU hours | Cost |
|---|---|---|---|---|---|
| **Base** | **MEASURED** | 9.5 s/video (full-corpus-30 mean) | 100,000 × 9.5 ÷ 3600 | 264 | **10827 RUB** |
| **Conservative** | **MEASURED** | 10.5 s/video (full-corpus-30 p95) | 100,000 × 10.5 ÷ 3600 | 291 | **11961 RUB** |
| *Optimistic* | *HYPOTHETICAL* | 12× effective throughput from batching | 264 ÷ 12 | 22 | *902 RUB* |

**The optimistic row is not a measurement and must not be quoted as one.** Every
timing in this document was taken at `ANALYSIS_CONCURRENCY=1`, so this corpus
contains *no* data on batched throughput. The 12× factor is an
assumption about what continuous batching might achieve on a 24 GB card; it has not
been tested here. It is expressed as effective throughput rather than as a
seconds-per-video figure so it cannot be mistaken for an observation. To replace it
with a real number, re-run the corpus at higher concurrency and measure.

**No USD conversion is shown.** No exchange rate has been supplied, and inventing one would turn a measured cost into a guess. Set `COST_RUB_PER_USD` and `COST_RUB_RATE_SOURCE` (rate plus date and source) to enable it.

For reference, the earlier local baseline used a hypothetical
`COST_GPU_HOURLY_USD=0.6` — that figure was ASSUMED and is superseded by
the measured RUB rate above.

Wall-clock time matters as much as money: the base scenario is
264 GPU-hours, i.e. 11 days on
one card, or roughly a day on 11 cards in parallel.
Analysis is embarrassingly parallel — one video per worker, no shared state — so
this trades directly against rental cost at the same total GPU-hours.

---

## 3. GPU inference — hosted API

Formula:

```
input_cost  = 100,000 x avg_tokens_in  / 1,000,000 x price_per_Mtok_in
output_cost = 100,000 x avg_tokens_out / 1,000,000 x price_per_Mtok_out
```

At `COST_HOSTED_INPUT_USD_PER_MTOK=0.2` and
`COST_HOSTED_OUTPUT_USD_PER_MTOK=0.6` (ASSUMED —
placeholder rates; substitute the chosen provider's published prices and record the
date and source here before quoting this figure):

| Component | Formula | Cost |
|---|---|---|
| Input | 100,000 × 3804 ÷ 1e6 × 0.2 | $76.09 |
| Output | 100,000 × 443 ÷ 1e6 × 0.6 | $26.58 |
| **Total** | | **$103** |

**Two caveats before anyone acts on this number.**

First, the token counts are MEASURED but the prices are ASSUMED placeholders. The
model is only as good as those two constants, which is why they live in `.env`
rather than in this text.

Second, and more important: **a hosted general-purpose API may refuse this content
outright.** Provider policies on explicit adult material must be checked before
treating hosted inference as an option at all — a cheaper price per token is
irrelevant if the request is rejected. This is the main reason the architecture
targets self-hosting.

---

## 4. Preprocessing (CPU)

Frame sampling, extraction, hashing and de-duplication. No GPU.

| Quantity | Formula | Result |
|---|---|---|
| Core-hours | 100,000 × 0.786 s ÷ 3600 | 22 |
| Cost at $0.0400/vCPU-hour (ASSUMED) | 22 × 0.04 | **$0.8733** |

Two orders of magnitude below inference. This is the point of adaptive sampling:
it moves work from the expensive tier to the cheap one. Sending whole videos to the
model instead would multiply the GPU line item by the ratio of total frames to
sampled frames — for this corpus, roughly 139x.

---

## 5. Storage

| Item | Formula | Result |
|---|---|---|
| Originals | 100,000 × 5.7 MB | 558 GB |
| Originals, monthly | 558 GB × $0.0230/GB (ASSUMED: S3 standard) | **$12.84/month** |
| Sampled frames | deleted after analysis | **$0** |
| Features + vectors | 100,000 × (448 B vector + ~2500 B jsonb) | 0.27 GB |

Sampled frames are deliberately transient — the pipeline deletes them once the
model call returns. Keeping 7 frames per video would
add roughly 40 GB
of permanent storage for artefacts that can be regenerated deterministically from
the source.

Storage is recurring where inference is one-off, so over a long enough horizon the
ordering reverses — though comparing the two here would require an exchange rate
between the measured RUB GPU cost and the assumed USD storage price, which has not
been supplied.

---

## 6. Network

Egress during analysis is internal (object storage → GPU worker in the same region)
and normally free. Viewer-facing media delivery is a separate, far larger line item
covered in ARCHITECTURE.md — at peak it is ~90 Gbps and is served by a CDN, not by
this pipeline.

---

## 7. Summary

| Line item | One-off | Recurring |
|---|---|---|
| GPU inference, base scenario | **10827 RUB** | — |
| Preprocessing CPU | $0.8733 (ASSUMED rate) | — |
| Object storage | — | $12.84/month (ASSUMED rate) |
| Database + vectors | — | negligible (0.27 GB) |

Currencies are deliberately not mixed into one total: the GPU line is a measured RUB
invoice rate, the others are assumed USD list prices. Combining them would need an
exchange rate that has not been supplied.

### The levers, in order of effect

1. **Frames per video.** Cost is linear in frames. The tiered budget (6/8/12/16)
   already halves the naive fixed-16 approach for short videos.
2. **Frame resolution.** Tokens scale with pixels: dropping
   `FRAME_MAX_LONG_EDGE` from 768 to 512 cuts tokens per
   frame by ~55%, at some cost to fine detail.
3. **Model size.** A 3B model at 4-bit was chosen because it fits 6 GB. On rented
   hardware the trade is quality against $/hour, and the benchmark is what decides
   whether the larger model earns its cost.
4. **A cheap pre-filter.** A specialist classifier could skip full VLM analysis for
   videos it can categorise confidently, cutting the GPU line item proportionally.
   Not implemented — it only pays once the corpus is large and the accuracy of the
   filter is known.

*Regenerate with `npm run cost-model`. Prices in `.env` are placeholders until
replaced with quoted vendor rates.*
