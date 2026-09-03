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

## Scope and honesty about it

Target size is **10–15 videos**. That is a smoke test, not a statistically robust
evaluation, and it is reported as such in ARCHITECTURE.md. It is sharp enough to
catch the failure that actually matters here: a model that misreads the taxonomy
in a consistent direction (e.g. never distinguishes `softcore` from `hardcore`, or
collapses every `setting` to `bedroom`).

Choose the videos to span the taxonomy rather than at random — include at least
one video per `explicitness` level, a mix of `performerCount`, and a few known-hard
cases (fast cuts, dim lighting, no clear act).

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
  "taxonomyVersion": 1,
  "reviewedBy": "name",
  "reviewedAt": "2026-09-04",
  "items": [
    {
      "videoId": "uuid-from-the-videos-table",
      "note": "Lighting is dim; body type is a judgement call.",
      "labels": {
        "performerCount": "solo",
        "performerGenders": ["female"],
        "hairColor": ["blonde"],
        "bodyType": ["slim"],
        "setting": "bedroom",
        "clothing": ["lingerie"],
        "actType": ["posing", "dancing"],
        "penetrationType": "none",
        "fetishTags": ["stockings"],
        "cameraFraming": "medium",
        "explicitness": "suggestive",
        "productionQuality": "amateur",
        "mood": "playful"
      }
    }
  ]
}
```

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
