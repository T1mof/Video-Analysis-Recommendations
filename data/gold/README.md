# Manually reviewed benchmark set

`labels.json` holds human-reviewed taxonomy labels for a small subset of the
ingested corpus. It is the only thing in this project that measures whether a
vision model is **correct**, as opposed to fast or cheap.

## Why it exists

`scripts/bench-vlm.ts` compares candidate models on four axes. Three of them —
latency, tokens, cost per video — are measured automatically from
`video_features`. The fourth, tagging quality, needs ground truth, and there is no
way to get it except by a person looking at the videos.

Without this file the benchmark would rank a fast, cheap, systematically wrong
model first.

## Two sets: DEV-15 and HOLDOUT-15

`labels.json` currently holds the **DEV-15** set — 15 of the 30 corpus videos.

Those 15 are **burned as an independent measure.** They have been used to compare
three vision models, to analyse per-field errors and to reason about the prompt.
Any score quoted against them is a fitted number, and it must be labelled DEV.

The remaining 15 videos are reserved as **HOLDOUT-15**, to be labelled in M8.4.
The rules are absolute, because a held-out set is worth nothing the moment it leaks:

- label them by hand **without** looking at any model predictions;
- never use them for prompt tuning;
- never use them for choosing a sampling strategy;
- never use them for model selection;
- open them **exactly once**, after the final configuration is frozen (M8.6).

After that single run, a GOLD-30 aggregate may also be reported, but HOLDOUT-15 is
the headline independent number. See [docs/ROADMAP.md](../../docs/ROADMAP.md).

## Scope and honesty about it

Target size is **10–15 videos** per set. That is a smoke test, not a statistically
robust evaluation, and it is reported as such in ARCHITECTURE.md. It is sharp enough
to catch the failure that actually matters here: a model that misreads the taxonomy
in a consistent direction (e.g. never distinguishes `nudity` from `explicit`, or
collapses every `setting` to `bedroom`).

Choose the videos to span the taxonomy rather than at random — include at least
one video per `explicitness` level, a mix of `performerCount`, and a few known-hard
cases (fast cuts, dim lighting, no clear act).

Record `unknown` freely where a field genuinely cannot be determined; it is a valid
label, not a gap. It is also worth measuring on its own: a model that answers
`unknown` far more often than the reviewer is over-cautious, and one that answers it
far less is guessing.

## How to produce it

1. Ingest the corpus (`npm run ingest`) and note the video ids.
2. Watch each selected video and fill in the taxonomy fields **before** looking at
   any model output. Recording labels after seeing a prediction is anchoring, and
   it inflates the score of whichever model you looked at.
3. Where a field is genuinely ambiguous, record the judgement call in `note`.
   Those notes are the honest caveat on the final numbers.
4. Save as `labels.json` in the shape below; it is validated by
   `goldDatasetSchema` in `src/analysis/gold.ts`.

## Shape

```json
{
  "taxonomyVersion": 2,
  "reviewedBy": "name",
  "reviewedAt": "2026-09-05",
  "items": [
    {
      "videoId": "uuid-from-the-videos-table",
      "note": "Lighting is dim; body type is a judgement call.",
      "labels": {
        "performerCount": "solo",
        "performerGender": "female",
        "adultAgeGroup": "25_34",
        "hairColor": "blonde",
        "bodyType": "slim",
        "breastSize": "medium",
        "buttSize": "medium",
        "penisSize": "unknown",
        "mediaType": "live_action",
        "setting": "bedroom",
        "clothing": "lingerie",
        "sexPosition": "none",
        "penetrationType": "none",
        "cameraStyle": "standard",
        "explicitness": "suggestive",
        "productionQuality": "amateur",
        "appearanceFeatures": ["tattoos"],
        "actType": ["posing", "dancing"],
        "fetishTags": ["stockings"]
      }
    }
  ]
}
```

All 19 fields are required. Sixteen take a single string; the three multi-value
fields — `appearanceFeatures`, `actType`, `fetishTags` — take arrays, and `[]` is
the correct way to record "none apply".

`aestheticScore`, `caption` and `confidence` are deliberately not labelled: the
first two are subjective and the third is a model self-report, so none of them has
a meaningful ground truth.

## Scoring

`compareToGold()` scores single-value fields as exact match and multi-value fields
by Jaccard overlap, and separately counts:

- **spurious** — values the model produced that the reviewer did not (hallucinated tags)
- **missed** — values the reviewer recorded that the model did not (missed tags)

Those two are reported separately from the aggregate score because they have
different consequences: a hallucinated `fetishTags` value actively misroutes
recommendations, while a missed one merely weakens them.

`labels.json` is gitignored along with the rest of `data/` — it references local
video ids and is regenerated per corpus.
