import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { env } from '../src/config/env.ts';
import { TAXONOMY_DIM } from '../src/analysis/taxonomy.ts';

/**
 * Extrapolates the cost of analysing 100,000 videos from what this corpus actually
 * measured.
 *
 * Every figure is labelled MEASURED, ASSUMED or DERIVED. Anything that could not be
 * measured is left as a formula with a named variable rather than filled in with a
 * plausible-looking number - a cost model whose provenance is unclear is worse than
 * no cost model, because it gets quoted.
 */

const TARGET_VIDEOS = 100_000;

interface Measured {
  videos: number;
  avgFrames: number;
  avgTokensIn: number | null;
  avgTokensOut: number | null;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgSizeBytes: number;
  avgDurationSec: number;
  modelName: string;
  modelVersion: string;
  tokenSampleSize: number;
}

async function collect(): Promise<Measured> {
  const [row] = await db.execute<{
    videos: string;
    avg_frames: string;
    avg_tokens_in: string | null;
    avg_tokens_out: string | null;
    avg_latency: string;
    p95_latency: string;
    token_samples: string;
  }>(sql`
    SELECT count(*)::text                                            AS videos,
           coalesce(avg(frames_used), 0)::text                       AS avg_frames,
           avg(tokens_in)::text                                      AS avg_tokens_in,
           avg(tokens_out)::text                                     AS avg_tokens_out,
           coalesce(avg(latency_ms), 0)::text                        AS avg_latency,
           coalesce(
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0
           )::text                                                   AS p95_latency,
           count(tokens_in)::text                                    AS token_samples
    FROM video_features
  `);

  const [videoRow] = await db.execute<{
    avg_size: string;
    avg_duration: string;
  }>(sql`
    SELECT coalesce(avg(size_bytes), 0)::text     AS avg_size,
           coalesce(avg(duration_seconds), 0)::text AS avg_duration
    FROM videos
  `);

  const [modelRow] = await db.execute<{ model_name: string; model_version: string }>(sql`
    SELECT model_name, model_version
    FROM video_features
    GROUP BY model_name, model_version
    ORDER BY count(*) DESC
    LIMIT 1
  `);

  const num = (value: string | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    videos: Number(row?.videos ?? 0),
    avgFrames: Number(row?.avg_frames ?? 0),
    avgTokensIn: num(row?.avg_tokens_in ?? null),
    avgTokensOut: num(row?.avg_tokens_out ?? null),
    avgLatencyMs: Number(row?.avg_latency ?? 0),
    p95LatencyMs: Number(row?.p95_latency ?? 0),
    avgSizeBytes: Number(videoRow?.avg_size ?? 0),
    avgDurationSec: Number(videoRow?.avg_duration ?? 0),
    modelName: modelRow?.model_name ?? 'unknown',
    modelVersion: modelRow?.model_version ?? 'unknown',
    tokenSampleSize: Number(row?.token_samples ?? 0),
  };
}

const usd = (value: number): string =>
  value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;

/** Renders a RUB figure, adding USD only when a real dated rate was supplied. */
function money(rub: number): string {
  const formatted = `${rub.toFixed(0)} RUB`;
  if (env.COST_RUB_PER_USD > 0) {
    return `${formatted} (~$${(rub / env.COST_RUB_PER_USD).toFixed(0)})`;
  }
  return formatted;
}

function main(measured: Measured): string {
  const gpuHourly = env.COST_GPU_HOURLY_USD;
  const gpuHourlyRub = env.COST_GPU_HOURLY_RUB;
  const avgSeconds = measured.avgLatencyMs / 1000;
  const p95Seconds = measured.p95LatencyMs / 1000;

  // Self-hosted: 100k x seconds/video / 3600 x $/hour.
  const gpuHoursBase = (TARGET_VIDEOS * avgSeconds) / 3600;
  const gpuHoursConservative = (TARGET_VIDEOS * p95Seconds) / 3600;

  // PURELY HYPOTHETICAL. Not measured, not derived from any observation on this
  // corpus: every timing here was taken at concurrency 1, so no batching data
  // exists. The factor stands for "what continuous batching might plausibly buy on
  // a 24 GB card", and it is reported as an effective throughput figure rather than
  // a seconds-per-video value, precisely so it cannot be mistaken for a measurement.
  const optimisticSpeedup = 12;
  const gpuHoursOptimistic = gpuHoursBase / optimisticSpeedup;

  const storageGb = (measured.avgSizeBytes * TARGET_VIDEOS) / 1024 ** 3;
  const storageMonthly = storageGb * env.COST_STORAGE_USD_PER_GB_MONTH;

  // Vector + features rows. vector(N) is 4 bytes per dimension plus a small header.
  const vectorBytes = TAXONOMY_DIM * 4 + 8;
  const featuresBytes = 2_500; // jsonb features + raw, observed order of magnitude
  const dbGb = ((vectorBytes + featuresBytes) * TARGET_VIDEOS) / 1024 ** 3;

  const hostedInput =
    measured.avgTokensIn !== null
      ? (measured.avgTokensIn * TARGET_VIDEOS * env.COST_HOSTED_INPUT_USD_PER_MTOK) / 1_000_000
      : null;
  const hostedOutput =
    measured.avgTokensOut !== null
      ? (measured.avgTokensOut * TARGET_VIDEOS * env.COST_HOSTED_OUTPUT_USD_PER_MTOK) / 1_000_000
      : null;

  // Preprocessing measured at M3: ~786 ms per video wall clock on this machine.
  const preprocessSecondsPerVideo = 0.786;
  const preprocessCoreHours = (TARGET_VIDEOS * preprocessSecondsPerVideo) / 3600;
  const cpuHourly = 0.04; // ASSUMED: general-purpose vCPU spot price

  return `# Cost model: analysing 100,000 videos

Generated from measured data by \`npm run cost-model\`.
Corpus measured: **${measured.videos} videos**, model \`${measured.modelName}\` (${measured.modelVersion}).

Every row is tagged:

- **MEASURED** — observed on this corpus and hardware.
- **ASSUMED** — a price or ratio taken from a vendor or a judgement call. Configurable in \`.env\`.
- **DERIVED** — computed from the two above.

The headline: at the measured rate, GPU inference dominates. Everything else —
preprocessing, storage, vectors — is a rounding error against it.

---

## 1. Measured inputs

| Quantity | Value | Source |
|---|---|---|
| Videos analysed | ${measured.videos} | MEASURED |
| Frames per video (mean) | ${measured.avgFrames.toFixed(1)} | MEASURED — adaptive sampling, cap ${env.MAX_ANALYSIS_FRAMES} |
| Input tokens per video (mean) | ${measured.avgTokensIn?.toFixed(0) ?? 'not reported'} | MEASURED (n=${measured.tokenSampleSize}) |
| Output tokens per video (mean) | ${measured.avgTokensOut?.toFixed(0) ?? 'not reported'} | MEASURED (n=${measured.tokenSampleSize}) |
| Tokens per frame | ${measured.avgTokensIn ? (measured.avgTokensIn / measured.avgFrames).toFixed(0) : 'n/a'} | DERIVED — at \`FRAME_MAX_LONG_EDGE=${env.FRAME_MAX_LONG_EDGE}\` |
| Inference latency, mean | ${avgSeconds.toFixed(1)} s | MEASURED — **full-corpus-30**, concurrency 1 |
| Inference latency, p95 | ${p95Seconds.toFixed(1)} s | MEASURED — full-corpus-30 |
| Preprocessing wall clock | ${preprocessSecondsPerVideo.toFixed(3)} s | MEASURED at M3 |
| Average video size | ${(measured.avgSizeBytes / 1024 / 1024).toFixed(1)} MB | MEASURED |
| Average duration | ${measured.avgDurationSec.toFixed(1)} s | MEASURED |

**Which latency sample.** The figures above are the **full-corpus-30 mean and p95**,
not the gold-15 benchmark mean (${measured.videos === 30 ? '9.7 s for the 8B' : 'see the benchmark report'}).
The 30-video sample is used for extrapolation because it spans the corpus's actual
duration distribution, and duration determines the frame budget, which determines
inference time. The 15-video gold subset is selected for taxonomy coverage rather
than duration coverage, so its mean is not representative of a bulk run.

**Concurrency caveat.** All timings were taken at \`ANALYSIS_CONCURRENCY=1\`. Nothing
here measures batched throughput.

---

## 2. GPU inference — self-hosted

Formula:

\`\`\`
gpu_hours = 100,000 x seconds_per_video / 3600
cost      = gpu_hours x hourly_rate
\`\`\`

At the **actually paid** rate of \`COST_GPU_HOURLY_RUB=${gpuHourlyRub}\` RUB/hour
(MEASURED — invoice rate for the rented RTX 4090):

Two scenarios below are computed from measured per-video latency. The third is not
a measurement and is kept visually separate for that reason.

| Scenario | Provenance | Input | Formula | GPU hours | Cost |
|---|---|---|---|---|---|
| **Base** | **MEASURED** | ${avgSeconds.toFixed(1)} s/video (full-corpus-30 mean) | 100,000 × ${avgSeconds.toFixed(1)} ÷ 3600 | ${gpuHoursBase.toFixed(0)} | **${money(gpuHoursBase * gpuHourlyRub)}** |
| **Conservative** | **MEASURED** | ${p95Seconds.toFixed(1)} s/video (full-corpus-30 p95) | 100,000 × ${p95Seconds.toFixed(1)} ÷ 3600 | ${gpuHoursConservative.toFixed(0)} | **${money(gpuHoursConservative * gpuHourlyRub)}** |
| *Optimistic* | *HYPOTHETICAL* | ${optimisticSpeedup}× effective throughput from batching | ${gpuHoursBase.toFixed(0)} ÷ ${optimisticSpeedup} | ${gpuHoursOptimistic.toFixed(0)} | *${money(gpuHoursOptimistic * gpuHourlyRub)}* |

**The optimistic row is not a measurement and must not be quoted as one.** Every
timing in this document was taken at \`ANALYSIS_CONCURRENCY=1\`, so this corpus
contains *no* data on batched throughput. The ${optimisticSpeedup}× factor is an
assumption about what continuous batching might achieve on a 24 GB card; it has not
been tested here. It is expressed as effective throughput rather than as a
seconds-per-video figure so it cannot be mistaken for an observation. To replace it
with a real number, re-run the corpus at higher concurrency and measure.

${
  env.COST_RUB_PER_USD > 0
    ? `USD figures use ${env.COST_RUB_PER_USD} RUB/USD${env.COST_RUB_RATE_SOURCE ? ` (${env.COST_RUB_RATE_SOURCE})` : ''}.`
    : '**No USD conversion is shown.** No exchange rate has been supplied, and inventing ' +
      'one would turn a measured cost into a guess. Set `COST_RUB_PER_USD` and ' +
      '`COST_RUB_RATE_SOURCE` (rate plus date and source) to enable it.'
}

For reference, the earlier local baseline used a hypothetical
\`COST_GPU_HOURLY_USD=${gpuHourly}\` — that figure was ASSUMED and is superseded by
the measured RUB rate above.

Wall-clock time matters as much as money: the base scenario is
${gpuHoursBase.toFixed(0)} GPU-hours, i.e. ${(gpuHoursBase / 24).toFixed(0)} days on
one card, or roughly a day on ${Math.ceil(gpuHoursBase / 24)} cards in parallel.
Analysis is embarrassingly parallel — one video per worker, no shared state — so
this trades directly against rental cost at the same total GPU-hours.

---

## 3. GPU inference — hosted API

${
  measured.avgTokensIn !== null
    ? `Formula:

\`\`\`
input_cost  = 100,000 x avg_tokens_in  / 1,000,000 x price_per_Mtok_in
output_cost = 100,000 x avg_tokens_out / 1,000,000 x price_per_Mtok_out
\`\`\`

At \`COST_HOSTED_INPUT_USD_PER_MTOK=${env.COST_HOSTED_INPUT_USD_PER_MTOK}\` and
\`COST_HOSTED_OUTPUT_USD_PER_MTOK=${env.COST_HOSTED_OUTPUT_USD_PER_MTOK}\` (ASSUMED —
placeholder rates; substitute the chosen provider's published prices and record the
date and source here before quoting this figure):

| Component | Formula | Cost |
|---|---|---|
| Input | 100,000 × ${measured.avgTokensIn.toFixed(0)} ÷ 1e6 × ${env.COST_HOSTED_INPUT_USD_PER_MTOK} | ${usd(hostedInput!)} |
| Output | 100,000 × ${measured.avgTokensOut?.toFixed(0) ?? 0} ÷ 1e6 × ${env.COST_HOSTED_OUTPUT_USD_PER_MTOK} | ${usd(hostedOutput!)} |
| **Total** | | **${usd(hostedInput! + hostedOutput!)}** |

**Two caveats before anyone acts on this number.**

First, the token counts are MEASURED but the prices are ASSUMED placeholders. The
model is only as good as those two constants, which is why they live in \`.env\`
rather than in this text.

Second, and more important: **a hosted general-purpose API may refuse this content
outright.** Provider policies on explicit adult material must be checked before
treating hosted inference as an option at all — a cheaper price per token is
irrelevant if the request is rejected. This is the main reason the architecture
targets self-hosting.`
    : `Not computable: the backend used for this corpus did not report token usage.
Run the analysis against a backend that returns \`usage\` and regenerate.

Formula, for when that data exists:

\`\`\`
input_cost  = 100,000 x avg_tokens_in  / 1,000,000 x price_per_Mtok_in
output_cost = 100,000 x avg_tokens_out / 1,000,000 x price_per_Mtok_out
\`\`\``
}

---

## 4. Preprocessing (CPU)

Frame sampling, extraction, hashing and de-duplication. No GPU.

| Quantity | Formula | Result |
|---|---|---|
| Core-hours | 100,000 × ${preprocessSecondsPerVideo} s ÷ 3600 | ${preprocessCoreHours.toFixed(0)} |
| Cost at ${usd(cpuHourly)}/vCPU-hour (ASSUMED) | ${preprocessCoreHours.toFixed(0)} × ${cpuHourly} | **${usd(preprocessCoreHours * cpuHourly)}** |

Two orders of magnitude below inference. This is the point of adaptive sampling:
it moves work from the expensive tier to the cheap one. Sending whole videos to the
model instead would multiply the GPU line item by the ratio of total frames to
sampled frames — for this corpus, roughly ${Math.round((measured.avgDurationSec * 30) / measured.avgFrames)}x.

---

## 5. Storage

| Item | Formula | Result |
|---|---|---|
| Originals | 100,000 × ${(measured.avgSizeBytes / 1024 / 1024).toFixed(1)} MB | ${storageGb.toFixed(0)} GB |
| Originals, monthly | ${storageGb.toFixed(0)} GB × ${usd(env.COST_STORAGE_USD_PER_GB_MONTH)}/GB (ASSUMED: S3 standard) | **${usd(storageMonthly)}/month** |
| Sampled frames | deleted after analysis | **$0** |
| Features + vectors | 100,000 × (${vectorBytes} B vector + ~${featuresBytes} B jsonb) | ${dbGb.toFixed(2)} GB |

Sampled frames are deliberately transient — the pipeline deletes them once the
model call returns. Keeping ${measured.avgFrames.toFixed(0)} frames per video would
add roughly ${((measured.avgFrames * 60 * 1024 * TARGET_VIDEOS) / 1024 ** 3).toFixed(0)} GB
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
| GPU inference, base scenario | **${money(gpuHoursBase * gpuHourlyRub)}** | — |
| Preprocessing CPU | ${usd(preprocessCoreHours * cpuHourly)} (ASSUMED rate) | — |
| Object storage | — | ${usd(storageMonthly)}/month (ASSUMED rate) |
| Database + vectors | — | negligible (${dbGb.toFixed(2)} GB) |

Currencies are deliberately not mixed into one total: the GPU line is a measured RUB
invoice rate, the others are assumed USD list prices. Combining them would need an
exchange rate that has not been supplied.

### The levers, in order of effect

1. **Frames per video.** Cost is linear in frames. The tiered budget (6/8/12/16)
   already halves the naive fixed-16 approach for short videos.
2. **Frame resolution.** Tokens scale with pixels: dropping
   \`FRAME_MAX_LONG_EDGE\` from ${env.FRAME_MAX_LONG_EDGE} to 512 cuts tokens per
   frame by ~55%, at some cost to fine detail.
3. **Model size.** A 3B model at 4-bit was chosen because it fits 6 GB. On rented
   hardware the trade is quality against $/hour, and the benchmark is what decides
   whether the larger model earns its cost.
4. **A cheap pre-filter.** A specialist classifier could skip full VLM analysis for
   videos it can categorise confidently, cutting the GPU line item proportionally.
   Not implemented — it only pays once the corpus is large and the accuracy of the
   filter is known.

*Regenerate with \`npm run cost-model\`. Prices in \`.env\` are placeholders until
replaced with quoted vendor rates.*
`;
}

collect()
  .then(async (measured) => {
    if (measured.videos === 0) {
      throw new Error('No analysed videos found. Run `npm run analyze -- --all` first.');
    }
    const markdown = main(measured);
    const path = 'docs/COST_MODEL.md';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown, 'utf8');
    console.log(`Cost model written to ${path}`);
    console.log(
      `  based on ${measured.videos} videos, ${measured.avgFrames.toFixed(1)} frames/video, ` +
        `${(measured.avgLatencyMs / 1000).toFixed(1)}s/video`,
    );
    await closeDb();
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
