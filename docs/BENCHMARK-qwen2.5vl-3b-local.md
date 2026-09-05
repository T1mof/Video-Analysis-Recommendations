# VLM benchmark: qwen2.5vl-3b-16k

- Provider: `openai-compatible`
- Model: `qwen2.5vl-3b-16k` (ollama-q4-16k)
- Taxonomy v2, prompt v2
- Gold set: data/gold/labels.json, 15 videos reviewed by manual on 2026-09-05
- Generated: 2026-09-05T03:49:13.128Z

> **Provenance note added after generation.** This report was produced in
> `--stored` mode, scoring features already in the database. Those rows came from
> the 3B **full-corpus-30** run, so the PERFORMANCE block below is the gold-15
> subset of that run: mean 8,071 ms, p50 5,222 ms, p95 17,134 ms. Verified by
> recomputing from the raw export `data/benchmarks/qwen2.5vl-3b-local-features.json`.
>
> The `inference failures 0` and `schema repair retries 0/0` lines are artefacts of
> `--stored` mode, which runs no inference. The real figures come from the corpus
> run: **30 analyzed, 0 failed, 0 retries.** Later versions of `bench-vlm` label
> this explicitly; this file predates that fix and cannot be regenerated, because
> the database now holds Qwen3-VL-8B predictions.
>
> For the like-for-like model comparison see
> [MODEL_COMPARISON.md](MODEL_COMPARISON.md).


```

==============================================================================
OVERALL   videos scored 15/15
  macro score (all fields)      0.399
  macro over single fields      0.383
  macro over multi fields       0.485
  spurious tags (hallucinated)  169
  missed tags                   168
  inference failures            0
  schema repair retries         0/0

PERFORMANCE
  latency mean                  8071 ms
  latency p50 / p95             5222 / 17134 ms
  frames per video (mean)       7.5
  tokens in / out (mean)        9186 / 410
  tokens per frame (mean)       1230

PER-FIELD  (strict includes gold=unknown; informative excludes it)
  field                 kind    strict  inform.  n_inf  goldUnk  predUnk  prec   rec    spur  miss
  performerGender      single   0.07    0.07    15        0        0   n/a   n/a    14    14
  performerCount       single   0.13    0.13    15        0        0   n/a   n/a    13    13
  fetishTags           multi    0.13    0.13    15        0        0  0.07  0.20    13     4
  breastSize           single   0.20    0.13     8        7        3   n/a   n/a    12    12
  buttSize             single   0.20    0.10    10        5        3   n/a   n/a    12    12
  hairColor            single   0.27    0.10    10        5       10   n/a   n/a    11    11
  bodyType             single   0.27    0.21    14        1        4   n/a   n/a    11    11
  clothing             single   0.27    0.27    15        0        2   n/a   n/a    11    11
  penisSize            single   0.33    0.09    11        4       14   n/a   n/a    10    10
  sexPosition          single   0.33    0.33    15        0        1   n/a   n/a    10    10
  productionQuality    single   0.33    0.31    13        2        2   n/a   n/a    10    10
  cameraStyle          single   0.40    0.40    15        0        0   n/a   n/a     9     9
  explicitness         single   0.40    0.40    15        0        0   n/a   n/a     9     9
  actType              multi    0.49    0.49    15        0        0  0.60  0.50     8    12
  penetrationType      single   0.60    0.60    15        0        1   n/a   n/a     6     6
  adultAgeGroup        single   0.67    0.00     5       10       15   n/a   n/a     5     5
  setting              single   0.67    0.67    15        0        0   n/a   n/a     5     5
  appearanceFeatures   multi    0.83    0.83    15        0        0  1.00  0.33     0     4
  mediaType            single   1.00    1.00    15        0        0   n/a   n/a     0     0

PER-VIDEO
  video_28       0.16   worst: performerCount, performerGender, hairColor
  video_03       0.21   worst: performerCount, performerGender, adultAgeGroup
  video_07       0.23   worst: performerCount, performerGender, adultAgeGroup
  video_30       0.26   worst: performerCount, performerGender, hairColor
  video_21       0.34   worst: performerCount, performerGender, bodyType
  video_25       0.37   worst: performerCount, performerGender, hairColor
  video_16       0.39   worst: performerCount, performerGender, hairColor
  video_06       0.40   worst: performerCount, performerGender, hairColor
  video_11       0.42   worst: performerCount, performerGender, hairColor
  video_20       0.44   worst: performerCount, performerGender, hairColor
  video_01       0.47   worst: performerCount, performerGender, adultAgeGroup
  video_10       0.47   worst: adultAgeGroup, hairColor, bodyType
  video_05       0.55   worst: performerGender, bodyType, breastSize
  video_26       0.58   worst: performerCount, performerGender, breastSize
  video_14       0.68   worst: performerCount, performerGender, adultAgeGroup

TOP ERROR PATTERNS  (field: gold -> predicted)
  14x  performerGender: mixed -> female   [video_01, video_03, video_05]
  11x  performerCount: duo -> solo   [video_01, video_03, video_06]
   9x  cameraStyle: pov -> standard   [video_01, video_03, video_07]
   8x  explicitness: explicit -> suggestive   [video_03, video_05, video_07]
   7x  productionQuality: amateur -> semi_pro   [video_03, video_16, video_21]

WEAKEST SINGLE FIELDS  performerGender (0.07), performerCount (0.13), breastSize (0.20), buttSize (0.20), hairColor (0.27)
STRONGEST FIELDS       mediaType (1.00), appearanceFeatures (0.83), adultAgeGroup (0.67), setting (0.67), penetrationType (0.60)
==============================================================================
```

## Taxonomy field kinds

| field | kind | allowed values |
|---|---|---|
| performerCount | single | 4 |
| performerGender | single | 4 |
| adultAgeGroup | single | 5 |
| hairColor | single | 6 |
| bodyType | single | 6 |
| breastSize | single | 4 |
| buttSize | single | 4 |
| penisSize | single | 4 |
| mediaType | single | 3 |
| setting | single | 11 |
| clothing | single | 9 |
| sexPosition | single | 10 |
| penetrationType | single | 7 |
| cameraStyle | single | 4 |
| explicitness | single | 4 |
| productionQuality | single | 4 |
| appearanceFeatures | multi | 2 |
| actType | multi | 11 |
| fetishTags | multi | 8 |
