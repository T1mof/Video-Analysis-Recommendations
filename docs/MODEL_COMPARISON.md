# Model comparison: Qwen2.5-VL 3B vs Qwen3-VL 8B vs InternVL3 8B

Two vision models benchmarked against the same 15 hand-reviewed videos, with
**everything else held constant**: taxonomy v2, prompt v2, the same adaptive
sampler, the same 768 px frame limit, the same metrics. Only the model and the
hardware it runs on changed.

| | Baseline | Candidate |
|---|---|---|
| Model | `Qwen2.5-VL-3B-Instruct` (Q4_K_M) | `Qwen/Qwen3-VL-8B-Instruct-FP8` |
| Runtime | Ollama, custom 16k Modelfile | vLLM 0.11.0, OpenAI-compatible |
| Hardware | RTX 2060, 6 GB (local) | RTX 4090, 24 GB (rented) |
| Concurrency | 1 (VRAM-bound) | 1 |
| Report | [BENCHMARK-qwen2.5vl-3b-local.md](BENCHMARK-qwen2.5vl-3b-local.md) | [BENCHMARK-qwen3vl-8b-rented.md](BENCHMARK-qwen3vl-8b-rented.md) |

## Two kinds of number, kept apart

This comparison changed **two things at once**: the model and the deployment. That
is fine for a decision but fatal for attribution, so the results are split.

| | Comparable as model+prompt properties | Comparable only as deployments |
|---|---|---|
| **What** | Field accuracy, macro scores, spurious/missed tags, input tokens per frame, schema validity | Latency, VRAM, throughput |
| **Why** | Both models saw identical frames, identical prompt, identical taxonomy. Hardware cannot change which tag a model picks, nor how many visual tokens its encoder emits per image. | RTX 2060 + Ollama (Q4 GGUF) vs RTX 4090 + vLLM (FP8). Model size, GPU, quantisation and serving stack all differ — no latency difference can be attributed to model architecture alone. |

A 3B model on a 4090 would very likely beat both on latency. Nothing here measures
that.

## Model quality

| Metric | 3B | 8B | Change |
|---|---|---|---|
| **Macro score, all fields** | 0.399 | **0.549** | **+38%** |
| Macro, single-value fields | 0.383 | **0.517** | +35% |
| Macro, multi-value fields | 0.485 | **0.722** | +49% |
| Spurious (hallucinated) tags | 171 | **131** | −23% |
| Missed tags | 168 | **129** | −23% |
| Schema validation failures | 0 | 0 | — |
| Repair retries needed | 0 | 0 | — |
| Input tokens per frame | 1,230 | **528** | **−57%** |
| Input tokens per video | 9,186 | **3,946** | −57% |

Qwen3-VL uses **~57% fewer visual/input tokens per frame**, reducing context size
and inference workload. This is a property of its visual encoder, not of the
hardware.

It is deliberately **not** described as being "cheaper" here. For a self-hosted
deployment the bill is GPU time × hourly rate; token count affects cost only
indirectly, through how much work each request represents. Fewer tokens per frame
is what lets an 8B model serve the same 16-frame budget inside a 24k context
window — a capability gain rather than a line-item saving. Token count would map
directly to price only on a hosted per-token API.

## Deployment performance

Latency figures come from two different samples, labelled explicitly because the
mean does not agree between them. Both rows use the **same provenance for both
models**: each model's full-corpus-30 run, with the gold-15 row being that run
filtered to the 15 gold video ids. No figure mixes runs.

| Sample | 3B on RTX 2060 + Ollama | 8B FP8 on RTX 4090 + vLLM |
|---|---|---|
| **gold-15** mean | 8.07 s | 9.57 s |
| **gold-15** p50 / p95 | 5.22 s / 17.13 s | 9.35 s / **11.06 s** |
| **full-corpus-30** mean | 11.07 s | **9.49 s** |
| **full-corpus-30** p95 | 17.13 s | **10.5 s** |
| Per-video range | 4.5 – 21.0 s | 8.7 – 11.2 s |
| Observed VRAM | ~4.7 GB of 6.1 | 18.1 GB of 24.5 |

**The mean flips between samples**, so "which is faster" has no single answer: the
3B deployment is faster on the gold-15 mean and slower on the full-corpus mean.
The reason is variance — the 3B ranges over a 4.6× spread while the 8B stays within
1.3×. The 8B deployment is *predictable*; the 3B deployment's average depends on
which videos you happen to measure.

For capacity planning that variance matters more than the mean, which is why the
cost model uses the full-corpus-30 figure (larger sample, spans the real duration
distribution) and reports a p95 scenario alongside it.

### Why these figures were previously inconsistent

Earlier drafts of these documents disagreed with each other, and the cause is worth
recording because it is a trap the tooling made easy to fall into.

Three different 3B timing sets existed:

| Run | mean | p50 | p95 |
|---|---|---|---|
| gold-15, fresh inference (includes model cold-start) | 12,809 ms | 13,046 ms | 22,545 ms |
| gold-15, `--stored` re-scoring (reads DB rows) | 8,071 ms | 5,222 ms | 17,134 ms |
| full-corpus-30 | 11,072 ms | 12,604 ms | 17,134 ms |

Different documents drew the mean from one and the percentiles from another. The
mechanism: `bench-vlm --stored` reports latencies read from `video_features`, which
by then had been overwritten by the corpus run — so a "gold benchmark" report
silently contained corpus-run timings.

Fixed by picking one source per model and deriving everything from it. For the 3B
that is `data/benchmarks/qwen2.5vl-3b-local-features.json`, the raw export of the
full-corpus run (30 videos with per-video `latency_ms`), recomputed with the same
percentile method as `scripts/bench-vlm.ts`. For the 8B it is the equivalent corpus
run, read back through `--stored`.

`bench-vlm` now labels its PERFORMANCE block with the sample it used and refuses to
report failure or retry counts in `--stored` mode, where no inference happens.

## The six fields called out for comparison

| Field | 3B | 8B | Change | Reading |
|---|---|---|---|---|
| `performerCount` | 0.13 | **0.73** | **+0.60** | The single biggest win |
| `performerGender` | 0.07 | **0.40** | **+0.33** | Still the weakest common field, but no longer broken |
| `cameraStyle` | 0.40 | **0.53** | +0.13 | POV now recognised, sometimes confused with selfie |
| `hairColor` | 0.27 | **0.53** | +0.26 | Informative score 0.10 → **0.80** — the real jump |
| `penetrationType` | 0.60 | 0.53 | **−0.07** | Small regression |
| `fetishTags` | 0.13 | **0.70** | **+0.57** | Precision 0.07 → 0.50 |

`hairColor` is the clearest illustration of why the unknown split exists. Strict
went 0.27 → 0.53, which looks like a moderate gain. But the 3B answered `unknown`
10 times out of 15 and scored **0.10** on the videos where the reviewer committed to
a colour; the 8B answers `unknown` **zero** times and scores **0.80** on those same
videos. The strict number understates the improvement by a wide margin.

## Where the 8B is genuinely strong

| Field | 3B | 8B |
|---|---|---|
| `appearanceFeatures` | 0.83 | **1.00** (precision 1.00, recall 1.00) |
| `mediaType` | 1.00 | 1.00 |
| `explicitness` | 0.40 | **0.80** |
| `performerCount` | 0.13 | **0.73** |
| `fetishTags` | 0.13 | **0.70** |

The 3B's dominant failure — POV footage read as a solo woman in ordinary framing —
is largely fixed. `performerGender: mixed → female` fell from 14/15 occurrences to
8/15, and `performerCount: duo → solo` (11/15 in the baseline) dropped out of the
top-five error patterns entirely.

## Where the 8B is worse

**`clothing`: 0.27 → 0.07.** This is a real regression, not noise, and it is the
one place the larger model is clearly worse.

The distribution explains it:

| | `nude` | `partially_nude` | `lingerie` | `casual` | `other` |
|---|---|---|---|---|---|
| Reviewer (gold) | 7 | 5 | 1 | — | — |
| 8B prediction | 1 | 4 | 3 | 2 | 5 |

The model systematically **under-calls nudity** and escapes into `other` — a value
the reviewer never used once. It is not refusing to perceive explicit content:
`explicitness` simultaneously improved from 0.40 to 0.80, so it sees what is
happening and hedges specifically on how it describes clothing. That pattern is
consistent with instruction-tuning on a more heavily aligned model.

`penetrationType` also slipped slightly (0.60 → 0.53), and `actType` is
essentially flat (0.49 → 0.47).

**`adultAgeGroup`: informative accuracy = 0 for both tested models.** Strict goes
0.67 → 0.40, but the informative score is **0.00 for both** — neither has produced a
correct age band on a video where the reviewer committed to one. The strict score is
entirely an artefact of agreeing about ignorance.

The field **stays in taxonomy v2 unchanged**. It is a candidate for redesign or
removal in taxonomy v3; changing it now would invalidate the gold set and both
benchmark runs.

## Conclusion for model choice

**Qwen3-VL-8B-FP8 on rented hardware is the better choice**: better on 15 of 19
fields, 38% higher macro, 57% fewer input tokens per frame, and far more predictable
latency (p95 11.2 s vs 17.1 s). Note that it is *not* uniformly faster — see the
deployment section; the case rests on quality and predictability, not raw speed.

It is still not a strong classifier in absolute terms. 0.549 macro means roughly
half the field values disagree with a human reviewer, and the recommender is built
to tolerate that — features are confidence-weighted, `unknown` contributes nothing
to the content vector, and candidate generation is multi-source precisely so no
single signal has to be right.

The 15 videos are a **development set (DEV-15)**: this document is itself the reason
they can no longer be an independent measure. Scores here are fitted numbers. The
independent claim comes later, from HOLDOUT-15 in M8.6 — see
[ROADMAP.md](ROADMAP.md).

Two follow-ups the evidence supports — both deliberately **not** done yet, and both
scoped to **M8.5**, after the MVP:

1. **`clothing` is a prompt problem, not a model problem.** The failure is a
   value-choice habit (`other` as an escape hatch), which an explicit instruction
   could plausibly correct. It has not been attempted, because tuning the prompt
   against these same 15 videos would overfit to the gold set and contaminate every
   subsequent model comparison. Any such change needs either a held-out set or a
   fresh benchmark run on both models afterwards.
2. **`adultAgeGroup` needs a taxonomy v3 decision.** Two models, zero informative
   accuracy. Left untouched in v2 so the existing gold set and both benchmark runs
   remain valid.

## Third model: InternVL3-8B (benchmarked)

`OpenGVLab/InternVL3-8B` was benchmarked as an independent competitor from a
different model family, so the choice does not rest on one lineage only.

| | InternVL3-8B |
|---|---|
| Checkpoint | `OpenGVLab/InternVL3-8B`, **unquantized BF16** |
| Runtime | vLLM 0.11.0, OpenAI-compatible, `max_dynamic_patch=4` |
| Hardware | RTX 4090, 24 GB (rented) — same card as the 8B run |
| Concurrency | 1 (`--max-num-seqs 1`) |
| Predictions | `data/benchmarks/internvl3-8b-gold.json` (not persisted to the DB) |

### Result

| Metric | 3B | **Qwen3-VL 8B** | InternVL3 8B |
|---|---:|---:|---:|
| Videos scored | 15/15 | 15/15 | **13/15** |
| **Coverage** | 100% | **100%** | 86.7% |
| Schema validation failures | 0 | **0** | 2 |
| Repair retries | 0 | 0 | 1 of 13 |
| *Valid output only* | | | |
| Macro, all fields | 0.399 | **0.549** | 0.420 |
| Macro, single | 0.383 | **0.517** | 0.380 |
| Macro, multi | 0.485 | **0.722** | 0.632 |
| *End-to-end (failures = 0)* | | | |
| **Macro, all fields** | 0.399 | **0.549** | 0.364 |
| Macro, single | 0.383 | **0.517** | 0.329 |
| Macro, multi | 0.485 | **0.722** | 0.548 |
| Spurious tags | 171 | 131 | 139 |
| Missed tags | 168 | 129 | 147 |

InternVL3 is the only model of the three that failed to produce valid taxonomy
output at all — twice, on both attempts, after emitting values outside the closed
vocabulary on many fields at once.

### Two scores, because coverage differs

**Valid-output-only** answers "when this model answers, how good is the answer?"
It is computed over the 13 videos InternVL3 completed and the 15 each Qwen
completed. Quoting it alone across models with different coverage would **reward the
model that refused more videos** — a model that answers one video perfectly would
score 1.000.

**End-to-end** scores a video with no valid output as 0 on every field. That is what
the pipeline actually experiences: an unanalysed video has no features, no embedding
and cannot be recommended. The two views coincide exactly at 100% coverage, which is
why both Qwen columns repeat.

Both are produced by `summarize(results, attempted)` from the same per-video
comparisons — the penalty is the denominator, not a correction applied afterwards.
Reproduce without a GPU:

```bash
npm run bench-vlm -- --load-predictions data/benchmarks/internvl3-8b-gold.json
```

### The ten fields called out for comparison

| Field | 3B | **Qwen3-VL 8B** | InternVL3 8B |
|---|---:|---:|---:|
| `performerCount` | 0.13 | **0.73** | 0.15 |
| `performerGender` | 0.07 | **0.40** | 0.00 |
| `hairColor` | 0.27 | 0.53 | **0.54** |
| `clothing` | 0.27 | 0.07 | **0.31** |
| `sexPosition` | 0.33 | **0.53** | 0.38 |
| `penetrationType` | 0.60 | 0.53 | 0.31 |
| `explicitness` | 0.40 | **0.80** | 0.38 |
| `cameraStyle` | 0.40 | 0.53 | **0.54** |
| `actType` | 0.49 | 0.47 | 0.47 |
| `fetishTags` | 0.13 | **0.70** | 0.62 |

InternVL3 wins three fields, and one of them matters: **`clothing` 0.31 vs 0.07**,
the 8B's worst regression. It is also marginally ahead on `hairColor` and
`cameraStyle`.

Those three are cosmetic/stylistic fields. The five that drive candidate generation
and ranking — `performerCount`, `performerGender`, `sexPosition`, `explicitness`,
`fetishTags` — go to Qwen3-VL by wide margins (0.73 vs 0.15, 0.40 vs 0.00, 0.53 vs
0.38, 0.80 vs 0.38, 0.70 vs 0.62). The model that wins the recommendation-critical
fields is not the one that wins the decorative ones, and that is the split the
choice turns on.

### Its failure mode is coherent, and it is the wrong one for this corpus

The error patterns are not scattered — they are one systematic behaviour:

```
12x  performerGender:   mixed   -> female
 9x  performerCount:    duo     -> solo
 6x  penetrationType:   vaginal -> none
 6x  explicitness:      explicit-> nudity
```

InternVL3 consistently describes only the female performer and consistently
under-states explicit activity. `performerGender` scored **0.00** — it did not get
that field right once. For a recommender whose candidate generation leans on
`performerCount`, `performerGender` and act semantics, this is the most damaging
place a model could be wrong, and it is wrong in a direction that no confidence
weighting can rescue.

### Cost of the tokens

| | Qwen3-VL 8B | InternVL3 8B |
|---|---:|---:|
| Input tokens per frame | **528** | 971 |
| Input tokens per video | **3,946** | 7,169 |
| Latency mean | **9.57 s** | 10.7 s |
| Latency p50 / p95 | 9.35 / **11.06 s** | 9.73 / 18.30 s |
| VRAM reserved | 18.1 GB | 22.6 GB |

InternVL3 needs ~84% more input tokens per frame because of dynamic tiling, even
capped at 4 tiles, and reserves more VRAM as an unquantized BF16 checkpoint against
the 8B's FP8. It is worse on quality **and** more expensive to serve.

**Latency provenance.** The Qwen figures above are each model's own gold-15 sample;
InternVL3 was only ever run on gold-15, so it has no full-corpus figure. The cost
model deliberately uses the **full-corpus-30** mean instead, because the gold set is
chosen for taxonomy coverage rather than duration coverage, and duration drives the
frame budget that drives inference time. No latency difference here is attributable
to model architecture alone: GPU, quantisation and serving stack differ between the
3B and the other two, and BF16-vs-FP8 differs between InternVL3 and Qwen3.

### Why the AWQ checkpoint was abandoned

The first attempt used `OpenGVLab/InternVL3-8B-AWQ` and never reached a serving
state. Two blockers:

**1. Startup multimodal profiler crash (worked around).** vLLM profiles capacity by
feeding the processor a synthetic `<image><video>` input; InternVL's processor
rejects the dummy video array (`TypeError: Cannot handle this data type: (1, 1, 3),
<i8`). Fixed with `--limit-mm-per-prompt '{"image": 16, "video": 0}'` — this
pipeline only ever sends images.

**2. Weight-name mismatch (fatal).** The vision tower failed to load at
`intern_vit.py:436` with `KeyError: 'encoder.layers.0.attn.qkv.weight'`. The cause:
the checkpoint declares AWQ only inside `llm_config.quantization_config`, but vLLM
resolves that through the text config and then applies it model-wide, including to
the ViT — which the checkpoint leaves unquantized. The loader therefore expects
`qweight/qzeros/scales` where the file has `weight`.

Rather than patch that, the unquantized BF16 checkpoint was used instead: it loads
on the same vLLM 0.11.0 with no changes at all. Nothing was installed or upgraded,
and the AWQ weights and config were left as downloaded.

`max_dynamic_patch` must be capped either way — InternVL tiles each image up to 12×,
which at 16 frames would be ~53k tokens.

### The benchmark bug this comparison exposed

The first InternVL3 run reported **macro 0.446 over 15/15 videos**. That result is
**invalid** and is used nowhere. What follows is why, because the failure mode
generalises.

`bench-vlm --no-persist` exists so a challenger can be evaluated without writing to
`video_features` and destroying the incumbent's corpus. Scoring, however, still fell
back to the stored row whenever an in-memory prediction was missing:

```ts
const features = predictions.get(item.videoId) ?? row?.features;
```

InternVL3 failed schema validation on two videos, so for those two the fallback
supplied **Qwen3-VL's stored features** and scored them as InternVL3's. The
incumbent was quietly propping up the challenger — on exactly the videos where the
challenger had collapsed — and the run looked like a clean 15/15.

This is benchmark contamination in the strict sense: one model's output counted as
another's, in the direction that hides the defect. The valid-only score was inflated
0.420 → 0.446, and the coverage failure disappeared entirely.

**Fix.** Under `--no-persist` (and `--load-predictions`) the database is never
consulted. A missing prediction stays missing; coverage falls out of the arithmetic
rather than being papered over; and the report prints the honest sample everywhere:
`videos scored 13/15 (coverage 86.7%)` and `PERFORMANCE (sample: 13 of gold-15)`
rather than implying a full run. Covered by tests in
[tests/analysis/gold.test.ts](../tests/analysis/gold.test.ts).

The transferable lesson: **an evaluation harness that shares storage with production
data can silently substitute one model's output for another's, and it will do so in
whichever direction hides the problem.** Worth checking explicitly in any such setup.

### Conclusion

**Qwen3-VL-8B-FP8 remains the selected model on a three-model comparison.** It beats
InternVL3 by 31% on valid-only macro and by 51% end-to-end, wins 7 of the 10
headline fields, and leads on tokens, latency predictability and VRAM — while never
failing to produce valid output.

The one thing InternVL3 demonstrates is that the 8B's `clothing` collapse (0.07) is
**not** an inherent difficulty of the corpus — a weaker model scores 0.31 on the same
frames. That supports the existing hypothesis that `clothing` is a prompt problem,
and it is still deliberately not acted on, for the reason given above.

## Fairness of the comparison

Held constant: taxonomy v2, prompt v2, adaptive sampler and frame budget,
`FRAME_MAX_LONG_EDGE=768`, de-duplication threshold, the 15 gold videos, all
metrics, concurrency 1. The prompt was **not** adjusted between runs, and no result
below informed a change to the prompt.

Changed together: model, GPU, quantisation (Q4 GGUF vs FP8) and serving stack
(Ollama vs vLLM). See the split at the top of this document for which numbers
survive that and which do not.

Both Qwen models produced valid taxonomy JSON on every single video, so neither of
those two results is skewed by one failing more often than the other. InternVL3
failed twice and is scored over 13 videos rather than 15 — stated wherever its
numbers appear.

The InternVL3 run is a **model + deployment** comparison, not a quantisation-
controlled one: it is BF16 against the 8B's FP8, and its dynamic tiling is a
property of the model. What was held identical is what matters for tagging quality —
the same sampled 768 px JPEG frames from the same M3 sampler, taxonomy v2, prompt
v2, the same gold labels and the same metrics. All three runs also used the same
output regime: vLLM rejected `json_schema` response_format in every run, so each
model was scored under prompt-enforced JSON with the same repair-retry budget.
