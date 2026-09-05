import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { videoFeatures, videos } from '../src/db/schema.ts';
import { env } from '../src/config/env.ts';
import { TAXONOMY, TAXONOMY_VERSION } from '../src/analysis/taxonomy.ts';
import { PROMPT_VERSION, type VideoFeatures } from '../src/analysis/schema.ts';
import {
  compareToGold,
  goldDatasetSchema,
  summarize,
  topErrorPatterns,
  type ComparisonResult,
  type GoldDataset,
} from '../src/analysis/gold.ts';
import { OpenAICompatibleProvider } from '../src/analysis/vision/openaiCompatible.ts';
import { MockVisionProvider } from '../src/analysis/vision/mock.ts';
import { analyzeVideo } from '../src/analysis/analyzeVideo.ts';
import type { VisionProvider } from '../src/analysis/vision/provider.ts';

/**
 * Benchmarks a vision model against the hand-reviewed gold set.
 *
 * Gold labels are read ONLY here, after inference has already happened. The model
 * never sees them, the sampler never sees them, and the retry path never sees
 * them - otherwise the benchmark would be measuring itself.
 */

interface Args {
  goldPath: string;
  provider: 'mock' | 'openai-compatible';
  model: string | null;
  modelVersion: string | null;
  baseUrl: string | null;
  /** Compare features already in the database instead of re-running inference. */
  stored: boolean;
  /** Run inference without writing to the database. */
  noPersist: boolean;
  /** Where to write raw per-video predictions as JSON. */
  savePredictions: string | null;
  /** Re-score a predictions file written by an earlier run, without inference. */
  loadPredictions: string | null;
  outPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    goldPath: 'data/gold/labels.json',
    provider: 'openai-compatible',
    model: null,
    modelVersion: null,
    baseUrl: null,
    stored: false,
    noPersist: false,
    savePredictions: null,
    loadPredictions: null,
    outPath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--gold') args.goldPath = argv[++i] ?? args.goldPath;
    else if (flag === '--provider') {
      const value = argv[++i];
      if (value !== 'mock' && value !== 'openai-compatible') {
        throw new Error(`--provider must be "mock" or "openai-compatible"`);
      }
      args.provider = value;
    } else if (flag === '--model') args.model = argv[++i] ?? null;
    else if (flag === '--model-version') args.modelVersion = argv[++i] ?? null;
    else if (flag === '--base-url') args.baseUrl = argv[++i] ?? null;
    else if (flag === '--stored') args.stored = true;
    else if (flag === '--no-persist') args.noPersist = true;
    else if (flag === '--save-predictions') args.savePredictions = argv[++i] ?? null;
    else if (flag === '--load-predictions') args.loadPredictions = argv[++i] ?? null;
    else if (flag === '--out') args.outPath = argv[++i] ?? null;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: npm run bench-vlm -- [options]\n\n' +
          '  --gold <path>            gold labels (default: data/gold/labels.json)\n' +
          '  --provider <p>           mock | openai-compatible (default: openai-compatible)\n' +
          '  --model <name>           override VISION_MODEL for this run\n' +
          '  --model-version <v>      override VISION_MODEL_VERSION\n' +
          '  --base-url <url>         override VISION_BASE_URL (e.g. an SSH tunnel)\n' +
          '  --stored                 score features already in the DB, no inference\n' +
          '  --no-persist             run inference WITHOUT writing to the database,\n' +
          '                           so evaluating a challenger cannot destroy the\n' +
          '                           incumbent model\'s corpus\n' +
          '  --save-predictions <p>   write raw per-video predictions as JSON\n' +
          '  --load-predictions <p>   re-score a saved predictions file, no inference\n' +
          '                           and no GPU - the model is never called\n' +
          '  --out <path>             also write the report as markdown\n' +
          '  -h, --help               show this help',
      );
      process.exit(0);
    }
  }
  return args;
}

function buildProvider(args: Args): VisionProvider {
  if (args.provider === 'mock') return new MockVisionProvider();
  return new OpenAICompatibleProvider({
    baseUrl: args.baseUrl ?? env.VISION_BASE_URL,
    model: args.model ?? env.VISION_MODEL,
    modelVersion: args.modelVersion ?? env.VISION_MODEL_VERSION,
  });
}

async function loadGold(path: string): Promise<GoldDataset> {
  const raw = await readFile(path, 'utf8');
  const parsed = goldDatasetSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Gold dataset ${path} is malformed:\n` +
        parsed.error.issues.map((i) => `  [${i.path.join('.')}] ${i.message}`).join('\n'),
    );
  }
  if (parsed.data.taxonomyVersion !== TAXONOMY_VERSION) {
    throw new Error(
      `Gold dataset is taxonomy v${parsed.data.taxonomyVersion}, code is v${TAXONOMY_VERSION}. ` +
        `Re-label or migrate before benchmarking - comparing across taxonomies is meaningless.`,
    );
  }
  return parsed.data;
}

interface RunStats {
  latencies: number[];
  tokensIn: number[];
  tokensOut: number[];
  frames: number[];
  attempts: number[];
  failures: { videoId: string; kind: string; error: string }[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const gold = await loadGold(args.goldPath);
  const provider = buildProvider(args);

  if (provider.synthetic) {
    console.log(
      '\n!!! Benchmarking the SYNTHETIC mock provider. Scores below measure nothing\n' +
        '!!! about video understanding - useful only to prove the harness works.\n',
    );
  }

  console.log(
    `Benchmarking ${gold.items.length} gold videos\n` +
      // In --load-predictions mode the configured provider is never called, so
      // naming it here would attribute the scores to the wrong model.
      (args.loadPredictions
        ? ''
        : `  provider  ${provider.name}\n  model     ${provider.modelName} (${provider.modelVersion})\n`) +
      `  taxonomy  v${TAXONOMY_VERSION}, prompt v${PROMPT_VERSION}\n` +
      `  mode      ${
        args.loadPredictions
          ? `re-scoring saved predictions from ${args.loadPredictions} (no inference)`
          : args.stored
            ? 'scoring stored features (no inference)'
            : args.noPersist
              ? 'running inference, NOT writing to the database'
              : 'running inference, writing to the database'
      }\n`,
  );

  const stats: RunStats = {
    latencies: [],
    tokensIn: [],
    tokensOut: [],
    frames: [],
    attempts: [],
    failures: [],
  };

  // Predictions held in memory when not persisting, so scoring never has to read
  // back rows that were never written.
  const predictions = new Map<string, VideoFeatures>();

  // Re-scoring a saved run: the predictions are already final, so the model is
  // never called. Videos missing from the file stay missing - they are exactly the
  // ones that failed on the original run, and hiding that would flatter the model.
  if (args.loadPredictions) {
    const saved = JSON.parse(await readFile(args.loadPredictions, 'utf8')) as {
      model?: string;
      modelVersion?: string;
      taxonomyVersion?: number;
      items: { videoId: string; features: VideoFeatures }[];
    };
    if (saved.taxonomyVersion !== undefined && saved.taxonomyVersion !== TAXONOMY_VERSION) {
      throw new Error(
        `Saved predictions are taxonomy v${saved.taxonomyVersion}, code is v${TAXONOMY_VERSION}. ` +
          `Scoring them against the current gold set would compare different vocabularies.`,
      );
    }
    for (const item of saved.items) predictions.set(item.videoId, item.features);
    console.log(
      `  loaded ${saved.items.length} predictions for ${saved.model ?? 'unknown model'}` +
        ` (${saved.modelVersion ?? 'unknown version'})\n`,
    );
  }

  // Inference first, scoring second: gold is not consulted until every prediction
  // exists, so there is no path by which a label could influence a prediction.
  if (!args.stored && !args.loadPredictions) {
    for (const item of gold.items) {
      const result = await analyzeVideo(item.videoId, {
        provider,
        force: true,
        persist: !args.noPersist,
      });
      if (result.features) predictions.set(item.videoId, result.features);
      if (result.status === 'failed') {
        stats.failures.push({
          videoId: item.videoId,
          kind: result.errorKind ?? 'unknown',
          error: result.error ?? 'unknown',
        });
        console.log(`  ! ${item.videoId} [${result.errorKind}] ${result.error}`);
        continue;
      }
      stats.latencies.push(result.visionLatencyMs ?? 0);
      if (result.tokensIn != null) stats.tokensIn.push(result.tokensIn);
      if (result.tokensOut != null) stats.tokensOut.push(result.tokensOut);
      stats.frames.push(result.framesUsed ?? 0);
      stats.attempts.push(result.attempts ?? 1);
      console.log(
        `  + ${item.videoId}  frames ${result.framesUsed}  ${result.visionLatencyMs} ms` +
          (result.attempts && result.attempts > 1 ? `  attempts ${result.attempts}` : ''),
      );
    }
  }

  const ids = gold.items.map((item) => item.videoId);
  const rows = await db
    .select({
      videoId: videoFeatures.videoId,
      features: videoFeatures.features,
      externalId: videos.externalId,
      framesUsed: videoFeatures.framesUsed,
      latencyMs: videoFeatures.latencyMs,
      tokensIn: videoFeatures.tokensIn,
      tokensOut: videoFeatures.tokensOut,
      modelName: videoFeatures.modelName,
    })
    .from(videoFeatures)
    .innerJoin(videos, eq(videos.id, videoFeatures.videoId))
    .where(inArray(videoFeatures.videoId, ids));

  const byId = new Map(rows.map((row) => [row.videoId, row]));

  const results: ComparisonResult[] = [];
  const nameById = new Map<string, string>();

  const rawPredictions: {
    videoId: string;
    externalId: string | null;
    features: VideoFeatures;
  }[] = [];

  for (const item of gold.items) {
    const row = byId.get(item.videoId);
    // In --no-persist mode the DB row still holds the *incumbent* model's features,
    // so falling back to it would score the incumbent under the challenger's name
    // on every video the challenger failed. Never fall back in that mode: a missing
    // prediction must stay missing and shrink the sample.
    const features =
      args.noPersist || args.loadPredictions
        ? predictions.get(item.videoId)
        : (predictions.get(item.videoId) ?? (row?.features as VideoFeatures | undefined));
    if (!features) continue;

    const externalId = row?.externalId ?? item.videoId;
    nameById.set(item.videoId, externalId);
    results.push(compareToGold(features, item));
    rawPredictions.push({ videoId: item.videoId, externalId: row?.externalId ?? null, features });

    if (args.stored && row) {
      if (row.latencyMs != null) stats.latencies.push(row.latencyMs);
      if (row.tokensIn != null) stats.tokensIn.push(row.tokensIn);
      if (row.tokensOut != null) stats.tokensOut.push(row.tokensOut);
      stats.frames.push(row.framesUsed);
    }
  }

  if (args.savePredictions) {
    await mkdir(dirname(args.savePredictions), { recursive: true });
    await writeFile(
      args.savePredictions,
      `${JSON.stringify(
        {
          model: provider.modelName,
          modelVersion: provider.modelVersion,
          provider: provider.name,
          taxonomyVersion: TAXONOMY_VERSION,
          promptVersion: PROMPT_VERSION,
          persisted: !args.noPersist,
          generatedAt: new Date().toISOString(),
          items: rawPredictions,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`raw predictions written to ${args.savePredictions}`);
  }

  const summary = summarize(results, gold.items.length);
  const patterns = topErrorPatterns(results, 5);

  const sortedLatency = [...stats.latencies].sort((a, b) => a - b);
  const mean = (xs: readonly number[]): number =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  const lines: string[] = [];
  const out = (line = ''): void => {
    lines.push(line);
    console.log(line);
  };

  out();
  out('='.repeat(78));
  out(
    `OVERALL   videos scored ${summary.videos}/${summary.attempted}` +
      `  (coverage ${(summary.coverage * 100).toFixed(1)}%)`,
  );
  out('  --- valid output only: how good the answers are when there IS an answer');
  out(`  macro score (all fields)      ${fmt(summary.macroScore)}`);
  out(`  macro over single fields      ${fmt(summary.singleMacro)}`);
  out(`  macro over multi fields       ${fmt(summary.multiMacro)}`);
  if (summary.coverage < 1) {
    // Comparing valid-only scores across models with different coverage rewards
    // the one that refused more videos, so show the penalised numbers too.
    out('  --- end-to-end: a video with no valid output scores 0 on every field');
    out(`  macro score (all fields)      ${fmt(summary.endToEndMacro)}`);
    out(`  macro over single fields      ${fmt(summary.endToEndSingleMacro)}`);
    out(`  macro over multi fields       ${fmt(summary.endToEndMultiMacro)}`);
  }
  out(`  spurious tags (hallucinated)  ${summary.totalSpurious}`);
  out(`  missed tags                   ${summary.totalMissed}`);
  if (args.stored || args.loadPredictions) {
    // No inference happened, so a "0 failures" line here would be an artefact of
    // the mode rather than a property of the model. Coverage above still shows how
    // many videos are missing; what failed on them is in the original run's log.
    const mode = args.stored ? '--stored' : '--load-predictions';
    out(`  inference failures            not measured in ${mode} mode`);
    out(`  schema repair retries         not measured in ${mode} mode`);
  } else {
    out(
      `  inference failures            ${stats.failures.length}` +
        (stats.failures.length
          ? ` (${[...new Set(stats.failures.map((f) => f.kind))].join(', ')})`
          : ''),
    );
    out(
      `  schema repair retries         ${stats.attempts.filter((a) => a > 1).length}/${stats.attempts.length}`,
    );
  }

  out();
  // Labelled with the sample it comes from: the gold set is chosen for taxonomy
  // coverage, not duration coverage, so its latency mean is not the right input for
  // extrapolating a bulk run - the cost model uses the full-corpus mean instead.
  // Latency/token stats cover only successful inferences, which is not always the
  // whole gold set - say so rather than implying a full sample.
  out(
    args.loadPredictions
      ? 'PERFORMANCE  (not measured - re-scored from a saved file, nothing ran)'
      : `PERFORMANCE  (sample: ${args.stored ? gold.items.length : stats.latencies.length}` +
          ` of gold-${gold.items.length}${args.stored ? ', from stored rows' : ', measured this run'})`,
  );
  if (sortedLatency.length) {
    out(`  latency mean                  ${Math.round(mean(sortedLatency))} ms`);
    out(`  latency p50 / p95             ${percentile(sortedLatency, 50)} / ${percentile(sortedLatency, 95)} ms`);
  } else {
    out('  latency                       not measured');
  }
  out(
    stats.frames.length
      ? `  frames per video (mean)       ${fmt(mean(stats.frames), 1)}`
      : '  frames per video (mean)       not measured',
  );
  if (stats.tokensIn.length) {
    out(`  tokens in / out (mean)        ${Math.round(mean(stats.tokensIn))} / ${Math.round(mean(stats.tokensOut))}`);
    out(`  tokens per frame (mean)       ${Math.round(mean(stats.tokensIn) / mean(stats.frames))}`);
  } else {
    out('  tokens                        not reported by this backend');
  }

  out();
  out('PER-FIELD  (strict includes gold=unknown; informative excludes it)');
  out(
    '  field                 kind    strict  inform.  n_inf  goldUnk  predUnk  prec   rec    spur  miss',
  );
  for (const report of [...summary.fieldReports].sort((a, b) => a.strictScore - b.strictScore)) {
    out(
      `  ${report.field.padEnd(20)} ${report.kind.padEnd(6)} ` +
        `${fmt(report.strictScore, 2).padStart(6)} ` +
        `${fmt(report.informativeScore, 2).padStart(7)} ` +
        `${String(report.informativeVideos).padStart(5)} ` +
        `${String(report.goldUnknown).padStart(8)} ` +
        `${String(report.predictedUnknown).padStart(8)} ` +
        `${fmt(report.precision, 2).padStart(5)} ` +
        `${fmt(report.recall, 2).padStart(5)} ` +
        `${String(report.spurious).padStart(5)} ` +
        `${String(report.missed).padStart(5)}`,
    );
  }

  out();
  out('PER-VIDEO');
  for (const result of [...results].sort((a, b) => a.macroScore - b.macroScore)) {
    const worst = result.perField
      .filter((f) => f.score < 1)
      .slice(0, 3)
      .map((f) => f.field)
      .join(', ');
    out(
      `  ${(nameById.get(result.videoId) ?? result.videoId).padEnd(14)} ` +
        `${fmt(result.macroScore, 2)}   worst: ${worst || 'none'}`,
    );
  }

  out();
  out('TOP ERROR PATTERNS  (field: gold -> predicted)');
  for (const pattern of patterns) {
    const names = pattern.examples.map((id) => nameById.get(id) ?? id).join(', ');
    out(
      `  ${String(pattern.count).padStart(2)}x  ${pattern.field}: ` +
        `${pattern.goldValue} -> ${pattern.predictedValue}   [${names}]`,
    );
  }

  const subjective = [...summary.fieldReports]
    .filter((f) => f.kind === 'single')
    .sort((a, b) => a.strictScore - b.strictScore)
    .slice(0, 5)
    .map((f) => `${f.field} (${fmt(f.strictScore, 2)})`);
  out();
  out(`WEAKEST SINGLE FIELDS  ${subjective.join(', ')}`);

  const strongest = [...summary.fieldReports]
    .sort((a, b) => b.strictScore - a.strictScore)
    .slice(0, 5)
    .map((f) => `${f.field} (${fmt(f.strictScore, 2)})`);
  out(`STRONGEST FIELDS       ${strongest.join(', ')}`);
  out('='.repeat(78));

  if (args.outPath) {
    const markdown = [
      `# VLM benchmark: ${provider.modelName}`,
      '',
      `- Provider: \`${provider.name}\``,
      `- Model: \`${provider.modelName}\` (${provider.modelVersion})`,
      `- Taxonomy v${TAXONOMY_VERSION}, prompt v${PROMPT_VERSION}`,
      `- Gold set: ${args.goldPath}, ${gold.items.length} videos reviewed by ${gold.reviewedBy} on ${gold.reviewedAt}`,
      `- Generated: ${new Date().toISOString()}`,
      provider.synthetic
        ? '\n> **SYNTHETIC PROVIDER** - these numbers measure the harness, not video understanding.'
        : '',
      '',
      '```',
      ...lines,
      '```',
      '',
      '## Taxonomy field kinds',
      '',
      '| field | kind | allowed values |',
      '|---|---|---|',
      ...Object.entries(TAXONOMY).map(
        ([key, field]) => `| ${key} | ${field.kind} | ${field.values.length} |`,
      ),
    ].join('\n');

    await mkdir(dirname(args.outPath), { recursive: true });
    await writeFile(args.outPath, `${markdown}\n`, 'utf8');
    console.log(`\nreport written to ${args.outPath}`);
  }

  if (stats.failures.length > 0) process.exitCode = 1;
}

main()
  .then(closeDb)
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
