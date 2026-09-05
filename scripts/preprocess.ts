import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { videos } from '../src/db/schema.ts';
import { env } from '../src/config/env.ts';
import {
  listPreprocessableVideoIds,
  preprocessVideo,
  type VideoPreprocessResult,
} from '../src/analysis/preprocess.ts';
import { buildContactSheet } from '../src/analysis/contactSheet.ts';

/**
 * CLI: npm run preprocess -- --video-id <uuid>
 *      npm run preprocess -- --all
 *
 * Frame sampling only. No vision model is involved at any point.
 */

interface Args {
  videoId: string | null;
  externalId: string | null;
  all: boolean;
  limit: number | null;
  outputDir: string;
  keepFrames: boolean;
  contactSheet: boolean;
  sceneAware: boolean | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    videoId: null,
    externalId: null,
    all: false,
    limit: null,
    outputDir: env.PREPROCESS_DEBUG_DIR,
    keepFrames: false,
    contactSheet: false,
    sceneAware: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--video-id') args.videoId = argv[++i] ?? null;
    else if (flag === '--external-id') args.externalId = argv[++i] ?? null;
    else if (flag === '--all') args.all = true;
    else if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--output-dir') args.outputDir = argv[++i] ?? args.outputDir;
    else if (flag === '--keep-frames') args.keepFrames = true;
    else if (flag === '--contact-sheet') args.contactSheet = true;
    else if (flag === '--scene-aware') args.sceneAware = true;
    else if (flag === '--no-scene-aware') args.sceneAware = false;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: npm run preprocess -- [options]\n\n' +
          '  --video-id <uuid>     preprocess one video by database id\n' +
          '  --external-id <name>  preprocess one video by source name, e.g. video_06\n' +
          '  --all                 preprocess the whole corpus\n' +
          '  --limit <n>           with --all, stop after n videos\n' +
          '  --output-dir <path>   where debug artefacts go (default: ' +
          env.PREPROCESS_DEBUG_DIR +
          ')\n' +
          '  --keep-frames         keep extracted frames instead of deleting them\n' +
          '  --contact-sheet       write a labelled grid of the selected frames\n' +
          '  --scene-aware         detect cuts (decodes the whole video; slow)\n' +
          '  --no-scene-aware      force scene detection off\n' +
          '  -h, --help            show this help',
      );
      process.exit(0);
    }
  }

  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number');
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

function reportOne(result: VideoPreprocessResult, sheetPath: string | null): void {
  const name = result.externalId ?? result.videoId;
  console.log(`\n${name}  (${result.videoId})`);
  console.log(
    `  duration ${result.durationSec.toFixed(1)}s  ${result.width}x${result.height}` +
      (result.sceneChangesDetected !== null
        ? `  scene cuts ${result.sceneChangesDetected}`
        : ''),
  );
  console.log(
    `  requested ${result.requestedFrames}  extracted ${result.extractedFrames}  ` +
      `duplicates removed ${result.removedDuplicates}  selected ${result.selectedFrames.length}`,
  );
  console.log(
    `  timestamps ${result.selectedFrames.map((f) => f.timestampSec.toFixed(2)).join(', ')}`,
  );
  console.log(`  ${result.processingMs} ms`);
  if (result.keptFramesDir) console.log(`  frames kept in ${result.keptFramesDir}`);
  if (sheetPath) console.log(`  contact sheet ${sheetPath}`);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function run(videoId: string, args: Args): Promise<VideoPreprocessResult> {
  let sheetPath: string | null = null;

  const result = await preprocessVideo(videoId, {
    keepFrames: args.keepFrames,
    outputDir: args.outputDir,
    sceneAware: args.sceneAware,
    beforeCleanup: async (pending) => {
      if (!args.contactSheet || pending.selectedFrames.length === 0) return;
      const name = pending.externalId ?? pending.videoId;
      sheetPath = join(args.outputDir, 'contact-sheets', `${name}.jpg`);
      await buildContactSheet(pending.selectedFrames, sheetPath);
    },
  });

  reportOne(result, sheetPath);
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const ids = args.all
    ? await listPreprocessableVideoIds(args.limit ?? undefined)
    : [args.videoId ?? (await resolveExternalId(args.externalId!))];

  console.log(`Preprocessing ${ids.length} video(s)...`);

  const results: VideoPreprocessResult[] = [];
  const failures: { videoId: string; error: string }[] = [];

  for (const id of ids) {
    try {
      results.push(await run(id, args));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ videoId: id, error: message });
      console.log(`\n! ${id}\n  FAILED: ${message}`);
    }
  }

  if (results.length > 1) {
    const selected = results.map((r) => r.selectedFrames.length);
    const totalDuration = results.reduce((sum, r) => sum + r.durationSec, 0);
    const totalRequested = results.reduce((sum, r) => sum + r.requestedFrames, 0);
    const totalExtracted = results.reduce((sum, r) => sum + r.extractedFrames, 0);
    const totalRemoved = results.reduce((sum, r) => sum + r.removedDuplicates, 0);
    const totalSelected = selected.reduce((a, b) => a + b, 0);
    const totalMs = results.reduce((sum, r) => sum + r.processingMs, 0);

    console.log('\n' + '='.repeat(60));
    console.log(`videos              ${results.length}`);
    console.log(`total duration      ${totalDuration.toFixed(1)}s`);
    console.log(`candidate frames    ${totalRequested}`);
    console.log(`extracted           ${totalExtracted}`);
    console.log(`removed duplicates  ${totalRemoved}`);
    console.log(`selected            ${totalSelected}`);
    console.log(
      `frames per video    min ${Math.min(...selected)}  median ${median(selected)}  max ${Math.max(...selected)}`,
    );
    console.log(
      `processing          ${(totalMs / 1000).toFixed(1)}s total, ` +
        `${Math.round(totalMs / results.length)} ms avg`,
    );
    console.log(`errors              ${failures.length}`);
  }

  if (failures.length > 0) process.exitCode = 1;
}

main()
  .then(closeDb)
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
