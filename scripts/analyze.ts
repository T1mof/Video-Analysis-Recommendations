import { eq } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { videos } from '../src/db/schema.ts';
import { env } from '../src/config/env.ts';
import {
  createVisionProvider,
  OpenAICompatibleProvider,
  SYNTHETIC_WARNING,
} from '../src/analysis/vision/index.ts';
import {
  analyzeVideo,
  listAnalyzableVideoIds,
  type AnalyzeResult,
} from '../src/analysis/analyzeVideo.ts';

/**
 * CLI: npm run analyze -- --all
 *      npm run analyze -- --external-id video_14 --provider openai-compatible
 *
 * Runs the analysis pipeline in-process. The BullMQ worker runs the same
 * analyzeVideo() function; this script exists so the corpus can be processed and
 * inspected without standing up a worker.
 */

interface Args {
  videoId: string | null;
  externalId: string | null;
  all: boolean;
  limit: number | null;
  force: boolean;
  provider: typeof env.VISION_PROVIDER;
  concurrency: number;
  baseUrl: string | null;
  model: string | null;
  modelVersion: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    videoId: null,
    externalId: null,
    all: false,
    limit: null,
    force: false,
    provider: env.VISION_PROVIDER,
    concurrency: 1,
    baseUrl: null,
    model: null,
    modelVersion: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--video-id') args.videoId = argv[++i] ?? null;
    else if (flag === '--external-id') args.externalId = argv[++i] ?? null;
    else if (flag === '--all') args.all = true;
    else if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--force') args.force = true;
    else if (flag === '--provider') {
      const value = argv[++i];
      if (value !== 'mock' && value !== 'openai-compatible') {
        throw new Error(`--provider must be "mock" or "openai-compatible", got "${value}"`);
      }
      args.provider = value;
    } else if (flag === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (flag === '--base-url') args.baseUrl = argv[++i] ?? null;
    else if (flag === '--model') args.model = argv[++i] ?? null;
    else if (flag === '--model-version') args.modelVersion = argv[++i] ?? null;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: npm run analyze -- [options]\n\n' +
          '  --video-id <uuid>     analyze one video by database id\n' +
          '  --external-id <name>  analyze one video by source name, e.g. video_14\n' +
          '  --all                 analyze every video that is not yet analyzed\n' +
          '  --limit <n>           with --all, stop after n videos\n' +
          '  --force               re-analyze videos that already have features\n' +
          '  --provider <p>        mock | openai-compatible (default: ' +
          env.VISION_PROVIDER +
          ')\n' +
          '  --concurrency <n>     parallel videos (keep at 1 on a small GPU)\n' +
          '  --base-url <url>      override VISION_BASE_URL (e.g. an SSH tunnel)\n' +
          '  --model <name>        override VISION_MODEL\n' +
          '  --model-version <v>   override VISION_MODEL_VERSION\n' +
          '  -h, --help            show this help',
      );
      process.exit(0);
    }
  }

  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number');
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error('--concurrency must be at least 1');
  }
  if (!args.all && !args.videoId && !args.externalId) {
    throw new Error('Pass --video-id <uuid>, --external-id <name>, or --all');
  }
  return args;
}

async function resolveExternalId(externalId: string): Promise<string> {
  const [row] = await db
    .select({ id: videos.id })
    .from(videos)
    .where(eq(videos.externalId, externalId))
    .limit(1);
  if (!row) throw new Error(`No video with external id "${externalId}"`);
  return row.id;
}

const ICON: Record<AnalyzeResult['status'], string> = {
  analyzed: '+',
  skipped: '=',
  failed: '!',
};

function describe(result: AnalyzeResult): string {
  const name = result.externalId ?? result.videoId;
  if (result.status === 'skipped') return `  = ${name} (already analyzed)`;
  if (result.status === 'failed') {
    return `  ! ${name} FAILED [${result.errorKind ?? 'unknown'}]: ${result.error ?? 'unknown'}`;
  }

  const tokens =
    result.tokensIn !== null && result.tokensIn !== undefined
      ? `  tokens ${result.tokensIn}/${result.tokensOut ?? 0}`
      : '';
  const retried = (result.attempts ?? 1) > 1 ? `  attempts ${result.attempts}` : '';

  return (
    `  ${ICON[result.status]} ${name}  frames ${result.framesUsed}` +
    `${tokens}  vlm ${result.visionLatencyMs} ms  total ${result.totalMs} ms${retried}\n` +
    `      ${result.caption ?? ''}`
  );
}

/** Runs tasks with a fixed worker pool - a 6 GB GPU cannot take much parallelism. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onResult: (result: R) => void,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const result = await fn(items[index]!);
      results[index] = result;
      onResult(result);
    }
  });

  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Explicit overrides beat the environment, so a one-off run against a tunnelled
  // remote server never depends on whether .env happens to shadow process.env.
  const provider =
    args.provider === 'openai-compatible' &&
    (args.baseUrl || args.model || args.modelVersion)
      ? new OpenAICompatibleProvider({
          baseUrl: args.baseUrl ?? env.VISION_BASE_URL,
          model: args.model ?? env.VISION_MODEL,
          modelVersion: args.modelVersion ?? env.VISION_MODEL_VERSION,
        })
      : createVisionProvider(args.provider);

  const ids = args.all
    ? (await listAnalyzableVideoIds(args.force)).slice(0, args.limit ?? undefined)
    : [args.videoId ?? (await resolveExternalId(args.externalId!))];

  if (provider.synthetic) {
    console.log(`\n!!! ${SYNTHETIC_WARNING}\n`);
  }

  console.log(
    `Analyzing ${ids.length} video(s) with provider "${provider.name}" ` +
      `(model ${provider.modelName} ${provider.modelVersion}), concurrency ${args.concurrency}\n`,
  );

  const results = await mapWithConcurrency(
    ids,
    args.concurrency,
    (id) => analyzeVideo(id, { provider, force: args.force }),
    (result) => console.log(describe(result)),
  );

  const analyzed = results.filter((r) => r.status === 'analyzed');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(
    `\nanalyzed ${analyzed.length}  skipped ${skipped.length}  failed ${failed.length}`,
  );

  if (failed.length > 0) {
    const byKind = new Map<string, number>();
    for (const result of failed) {
      const kind = result.errorKind ?? 'unknown';
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    console.log(
      'failures by kind:    ' +
        [...byKind].map(([kind, count]) => `${kind}=${count}`).join(', '),
    );
  }

  if (analyzed.length > 0) {
    const frames = analyzed.reduce((sum, r) => sum + (r.framesUsed ?? 0), 0);
    const vlmMs = analyzed.reduce((sum, r) => sum + (r.visionLatencyMs ?? 0), 0);
    const withTokens = analyzed.filter((r) => r.tokensIn !== null && r.tokensIn !== undefined);

    console.log(`frames analyzed     ${frames}`);
    console.log(
      `vlm latency         ${(vlmMs / 1000).toFixed(1)}s total, ` +
        `${Math.round(vlmMs / analyzed.length)} ms avg`,
    );

    if (withTokens.length > 0) {
      const tokensIn = withTokens.reduce((sum, r) => sum + (r.tokensIn ?? 0), 0);
      const tokensOut = withTokens.reduce((sum, r) => sum + (r.tokensOut ?? 0), 0);
      console.log(
        `tokens              ${tokensIn} in / ${tokensOut} out ` +
          `(${Math.round(tokensIn / withTokens.length)} in per video)`,
      );
    } else {
      console.log('tokens              not reported by this backend');
    }
  }

  if (provider.synthetic) {
    console.log(`\n!!! ${SYNTHETIC_WARNING}`);
  }

  if (failed.length > 0) process.exitCode = 1;
}

main()
  .then(closeDb)
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
