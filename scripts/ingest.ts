import { writeFile } from 'node:fs/promises';
import { closeDb } from '../src/db/client.ts';
import { closeQueues } from '../src/queue/queues.ts';
import { closeRedis } from '../src/queue/connection.ts';
import { DemoVideoSource } from '../src/ingest/sources/demo.ts';
import { ingestFromSource } from '../src/ingest/ingestService.ts';
import type { IngestOutcome, VideoSource } from '../src/ingest/types.ts';

/**
 * CLI: npm run ingest -- --source demo --limit 30
 *
 * Ends at a stored, `ingested` row. Analysis is NOT enqueued unless --enqueue is
 * passed; wiring the two together belongs with the analysis milestone.
 *
 * Only the demo source exists today. Fansly/Fanvue adapters are an optional bonus
 * scheduled after the main pipeline is complete; they would register here without
 * any change to the pipeline itself.
 */

interface Args {
  source: string;
  limit: number;
  enqueue: boolean;
  mappingOut: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { source: 'demo', limit: 30, enqueue: false, mappingOut: null };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--source') args.source = argv[++i] ?? args.source;
    else if (flag === '--limit') args.limit = Number(argv[++i] ?? args.limit);
    else if (flag === '--enqueue') args.enqueue = true;
    else if (flag === '--mapping-out') args.mappingOut = argv[++i] ?? null;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: npm run ingest -- [options]\n\n' +
          '  --source <name>     ingestion source (default: demo)\n' +
          '  --limit <n>         maximum items to take from the source (default: 30)\n' +
          '  --enqueue           also queue analysis jobs (off by default)\n' +
          '  --mapping-out <p>   write the filename -> videoId map as JSON\n' +
          '  -h, --help          show this help',
      );
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error(`--limit must be a positive number, got "${args.limit}"`);
  }
  return args;
}

function resolveSource(name: string): VideoSource {
  switch (name) {
    case 'demo':
      return new DemoVideoSource();
    default:
      throw new Error(`Unknown source "${name}". Available: demo`);
  }
}

const ICON: Record<IngestOutcome['status'], string> = {
  ingested: '+',
  duplicate: '=',
  rejected: '-',
  failed: '!',
};

function describe(outcome: IngestOutcome): string {
  const shape =
    outcome.width && outcome.height && outcome.durationSeconds
      ? ` ${outcome.width}x${outcome.height} ${outcome.durationSeconds.toFixed(1)}s`
      : '';
  const warn = outcome.warnings?.length
    ? ` (warning: ${outcome.warnings.join(', ')}${outcome.detail ? `: ${outcome.detail}` : ''})`
    : '';
  const enriched = outcome.creatorEnriched ? ' (creator backfilled)' : '';
  const why = outcome.reason ? ` [${outcome.reason}] ${outcome.detail ?? ''}` : '';
  const failure = outcome.status === 'failed' ? ` ${outcome.detail ?? ''}` : '';
  return `  ${ICON[outcome.status]} ${outcome.externalId}${shape}${enriched}${warn}${why}${failure}`.trimEnd();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = resolveSource(args.source);

  console.log(`Ingesting up to ${args.limit} items from "${source.name}"...\n`);

  const summary = await ingestFromSource(source, {
    limit: args.limit,
    enqueue: args.enqueue,
    onProgress: (outcome) => console.log(describe(outcome)),
  });

  console.log(
    `\ningested ${summary.ingested}  duplicates ${summary.duplicates}  ` +
      `rejected ${summary.rejected}  failed ${summary.failed}`,
  );

  const enrichedCount = summary.outcomes.filter((o) => o.creatorEnriched).length;
  if (enrichedCount > 0) {
    console.log(`creator attribution backfilled onto ${enrichedCount} existing row(s)`);
  }

  const warned = summary.outcomes.filter((o) => o.warnings?.length);
  if (warned.length > 0) {
    console.log(
      `warnings: ${warned.length} video(s) ingested with ` +
        `${[...new Set(warned.flatMap((o) => o.warnings ?? []))].join(', ')}`,
    );
  }

  if (summary.rejected > 0) {
    const byReason = new Map<string, number>();
    for (const o of summary.outcomes.filter((x) => x.status === 'rejected')) {
      byReason.set(o.reason ?? 'unknown', (byReason.get(o.reason ?? 'unknown') ?? 0) + 1);
    }
    console.log(
      'rejected by reason: ' +
        [...byReason].map(([reason, count]) => `${reason}=${count}`).join(', '),
    );
  }

  for (const warning of summary.unmatchedManifestEntries) {
    console.log(`manifest warning: ${warning}`);
  }

  // The gold dataset is keyed by database id, so the mapping has to be reachable
  // without opening psql - on duplicate runs too.
  const mapped = summary.outcomes.filter((o) => o.videoId);
  if (mapped.length > 0) {
    console.log('\nfilename -> videoId');
    for (const outcome of mapped) {
      console.log(`  ${(outcome.fileName ?? outcome.externalId).padEnd(16)} ${outcome.videoId}`);
    }
  }

  if (args.mappingOut) {
    const mapping = Object.fromEntries(
      mapped.map((o) => [o.fileName ?? o.externalId, o.videoId]),
    );
    await writeFile(args.mappingOut, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
    console.log(`\nmapping written to ${args.mappingOut}`);
  }

  if (args.enqueue && summary.ingested > 0) {
    console.log(`\n${summary.ingested} analysis job(s) queued.`);
  }

  if (summary.failed > 0) process.exitCode = 1;
}

async function shutdown(): Promise<void> {
  await closeQueues();
  await closeRedis();
  await closeDb();
}

main()
  .then(shutdown)
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await shutdown();
    process.exit(1);
  });
