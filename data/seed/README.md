# Demo corpus

## The videos are not in this repository

`videos/` holds the local corpus the demo runs on. It is gitignored: the material is
18+ and belongs to whoever produced it. Nothing here is redistributed.

To reproduce the demo, put 20–30 vertical videos in `data/seed/videos/` (or point
`DEMO_SOURCE_DIR` elsewhere) and run `npm run ingest`.

## The creators are synthetic

**`manifest.json` does not describe real authorship.** `creator_01` … `creator_10`
and `demo_creator_01` … `demo_creator_10` are invented labels, assigned to files
round-robin by filename. They say nothing about who actually produced any video, and
they must not be presented or exported as attribution.

They exist because two parts of the recommender are otherwise undemonstrable:

| Feature | Needs |
|---|---|
| `RANK_W_CREATOR_AFFINITY` | A user's interactions to concentrate on some creators and not others |
| `DIVERSITY_MAX_SAME_CREATOR` | More videos per creator than the cap allows, so the cap visibly binds |

Ten creators × three videos each is the smallest arrangement where both are visible:
liking one creator's video makes the other two candidates for the feed, and a feed
window that would otherwise stack all three gets trimmed by the per-creator cap.

Creator attribution stays nullable throughout the system precisely because real
sources frequently do not expose it. Videos with a null `creatorId` are exempt from
the per-creator cap and contribute nothing to creator affinity — the independent
tag-similarity diversity rule still applies to them.

## Files

| Path | Committed | What it is |
|---|---|---|
| `videos/` | no | The corpus itself |
| `manifest.json` | yes | Synthetic creator attribution (filenames only, no content) |
| `mapping.json` | no | `filename → videoId`, regenerated per corpus by `--mapping-out` |

`mapping.json` is generated, not authored: the UUIDs are assigned at ingestion and
differ on every fresh database, so committing it would only ever be misleading. Its
purpose is building the gold benchmark set, which is keyed by database id.

## Applying the manifest to an already-ingested corpus

Ingestion is checksum-idempotent, so re-running after adding a manifest reports
duplicates rather than inserting rows. Creator attribution is still backfilled onto
those existing rows, but only where it is currently null — an existing non-null value
is never silently overwritten, and a mismatch is reported as a `creator_conflict`
warning instead.
