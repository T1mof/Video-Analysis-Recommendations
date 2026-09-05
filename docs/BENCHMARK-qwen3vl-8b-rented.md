# VLM benchmark: qwen2.5vl-3b-16k

- Provider: `openai-compatible`
- Model: `qwen2.5vl-3b-16k` (ollama-q4-16k)
- Taxonomy v2, prompt v2
- Gold set: data/gold/labels.json, 15 videos reviewed by manual on 2026-09-05
- Generated: 2026-09-05T17:08:25.877Z


```

==============================================================================
OVERALL   videos scored 15/15
  macro score (all fields)      0.549
  macro over single fields      0.517
  macro over multi fields       0.722
  spurious tags (hallucinated)  131
  missed tags                   129
  inference failures            not measured in --stored mode
  schema repair retries         not measured in --stored mode

PERFORMANCE  (sample: gold-15, from stored rows)
  latency mean                  9568 ms
  latency p50 / p95             9353 / 11059 ms
  frames per video (mean)       7.5
  tokens in / out (mean)        3946 / 447
  tokens per frame (mean)       528

PER-FIELD  (strict includes gold=unknown; informative excludes it)
  field                 kind    strict  inform.  n_inf  goldUnk  predUnk  prec   rec    spur  miss
  clothing             single   0.07    0.07    15        0        0   n/a   n/a    14    14
  bodyType             single   0.20    0.14    14        1        1   n/a   n/a    12    12
  performerGender      single   0.40    0.40    15        0        0   n/a   n/a     9     9
  adultAgeGroup        single   0.40    0.00     5       10        9   n/a   n/a     9     9
  buttSize             single   0.40    0.40    10        5        2   n/a   n/a     9     9
  actType              multi    0.47    0.47    15        0        0  0.52  0.63    14     9
  breastSize           single   0.47    0.25     8        7        5   n/a   n/a     8     8
  penisSize            single   0.47    0.27    11        4        8   n/a   n/a     8     8
  hairColor            single   0.53    0.80    10        5        0   n/a   n/a     7     7
  sexPosition          single   0.53    0.53    15        0        0   n/a   n/a     7     7
  penetrationType      single   0.53    0.53    15        0        0   n/a   n/a     7     7
  cameraStyle          single   0.53    0.53    15        0        0   n/a   n/a     7     7
  productionQuality    single   0.53    0.62    13        2        0   n/a   n/a     7     7
  setting              single   0.67    0.67    15        0        0   n/a   n/a     5     5
  fetishTags           multi    0.70    0.70    15        0        0  0.50  0.20     1     4
  performerCount       single   0.73    0.73    15        0        0   n/a   n/a     4     4
  explicitness         single   0.80    0.80    15        0        0   n/a   n/a     3     3
  mediaType            single   1.00    1.00    15        0        0   n/a   n/a     0     0
  appearanceFeatures   multi    1.00    1.00    15        0        0  1.00  1.00     0     0

PER-VIDEO
  video_16       0.34   worst: performerCount, performerGender, adultAgeGroup
  video_21       0.37   worst: performerGender, adultAgeGroup, bodyType
  video_07       0.43   worst: performerCount, performerGender, adultAgeGroup
  video_30       0.47   worst: performerGender, bodyType, buttSize
  video_01       0.49   worst: performerGender, adultAgeGroup, bodyType
  video_05       0.50   worst: performerCount, performerGender, hairColor
  video_10       0.50   worst: performerGender, adultAgeGroup, bodyType
  video_26       0.50   worst: hairColor, bodyType, buttSize
  video_20       0.60   worst: adultAgeGroup, bodyType, breastSize
  video_06       0.61   worst: performerGender, bodyType, penisSize
  video_14       0.63   worst: performerCount, adultAgeGroup, hairColor
  video_28       0.63   worst: bodyType, buttSize, penisSize
  video_11       0.66   worst: performerGender, adultAgeGroup, breastSize
  video_25       0.74   worst: hairColor, bodyType, buttSize
  video_03       0.75   worst: adultAgeGroup, hairColor, penisSize

TOP ERROR PATTERNS  (field: gold -> predicted)
   8x  performerGender: mixed -> female   [video_01, video_05, video_06]
   6x  bodyType: average -> curvy   [video_05, video_07, video_16]
   5x  bodyType: slim -> curvy   [video_01, video_10, video_20]
   5x  buttSize: medium -> large   [video_16, video_20, video_25]
   4x  cameraStyle: pov -> selfie   [video_01, video_07, video_16]

WEAKEST SINGLE FIELDS  clothing (0.07), bodyType (0.20), performerGender (0.40), adultAgeGroup (0.40), buttSize (0.40)
STRONGEST FIELDS       mediaType (1.00), appearanceFeatures (1.00), explicitness (0.80), performerCount (0.73), fetishTags (0.70)
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
