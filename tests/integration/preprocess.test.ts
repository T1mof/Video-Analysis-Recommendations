import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { like } from 'drizzle-orm';
import { closeDb, db } from '../../src/db/client.ts';
import { videos } from '../../src/db/schema.ts';
import { DemoVideoSource } from '../../src/ingest/sources/demo.ts';
import { ingestFromSource } from '../../src/ingest/ingestService.ts';
import { PreprocessError, preprocessVideo } from '../../src/analysis/preprocess.ts';
import { buildContactSheet } from '../../src/analysis/contactSheet.ts';
import { deleteObject } from '../../src/storage/s3.ts';
import { env } from '../../src/config/env.ts';

const execFileAsync = promisify(execFile);

/**
 * End-to-end preprocessing against the real Postgres and MinIO.
 *
 * Opt-in via TEST_INTEGRATION=1. Fixtures are generated with ffmpeg, ingested
 * through the normal pipeline, then preprocessed - so this covers the real path
 * (S3 fetch -> probe -> sample -> extract -> dedupe -> cleanup), not a stub.
 */
const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'ptest_';
let dir: string;
let debugDir: string;
let movingId: string;
let staticId: string;

beforeAll(async () => {
  if (!enabled) return;

  dir = await mkdtemp(join(tmpdir(), 'preprocess-integration-'));
  debugDir = await mkdtemp(join(tmpdir(), 'preprocess-debug-'));

  // Continuously changing content: sampling should keep most frames.
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=25:duration=40',
    '-pix_fmt', 'yuv420p', '-y', join(dir, `${PREFIX}moving.mp4`),
  ]);

  // A single flat colour throughout: every frame is identical, so de-duplication
  // should collapse it to the configured minimum.
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=teal:size=180x320:rate=25:duration=40',
    '-pix_fmt', 'yuv420p', '-y', join(dir, `${PREFIX}static.mp4`),
  ]);

  await writeFile(join(dir, 'manifest.json'), '[]');

  const summary = await ingestFromSource(new DemoVideoSource(dir, join(dir, 'manifest.json')), {
    limit: 10,
  });
  movingId = summary.outcomes.find((o) => o.externalId === `${PREFIX}moving`)!.videoId!;
  staticId = summary.outcomes.find((o) => o.externalId === `${PREFIX}static`)!.videoId!;
}, 180_000);

afterAll(async () => {
  if (!enabled) return;

  const rows = await db
    .select({ s3Key: videos.s3Key, thumbKey: videos.thumbKey })
    .from(videos)
    .where(like(videos.externalId, `${PREFIX}%`));

  for (const row of rows) {
    await deleteObject(row.s3Key).catch(() => {});
    if (row.thumbKey) await deleteObject(row.thumbKey).catch(() => {});
  }

  await db.delete(videos).where(like(videos.externalId, `${PREFIX}%`));
  await rm(dir, { recursive: true, force: true });
  await rm(debugDir, { recursive: true, force: true });
  await closeDb();
}, 60_000);

describe.skipIf(!enabled)('preprocessVideo (integration)', () => {
  it('samples a video end to end from object storage', async () => {
    const result = await preprocessVideo(movingId);

    expect(result.videoId).toBe(movingId);
    expect(result.durationSec).toBeCloseTo(40, 0);
    // 40s falls in the 30-60s tier.
    expect(result.requestedFrames).toBe(env.FRAMES_TIER_MEDIUM);
    expect(result.extractedFrames).toBeGreaterThan(0);
    expect(result.selectedFrames.length).toBeGreaterThan(0);
    expect(result.processingMs).toBeGreaterThan(0);
  }, 120_000);

  it('never selects more than the hard cap', async () => {
    const result = await preprocessVideo(movingId);
    expect(result.selectedFrames.length).toBeLessThanOrEqual(env.MAX_ANALYSIS_FRAMES);
  }, 120_000);

  it('returns chronological timestamps with a hash on every frame', async () => {
    const result = await preprocessVideo(movingId);
    const times = result.selectedFrames.map((f) => f.timestampSec);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const frame of result.selectedFrames) {
      expect(frame.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  }, 120_000);

  it('collapses a completely static video to the configured minimum', async () => {
    const result = await preprocessVideo(staticId);
    expect(result.removedDuplicates).toBeGreaterThan(0);
    expect(result.selectedFrames.length).toBe(env.MIN_ANALYSIS_FRAMES);
  }, 120_000);

  it('deletes temporary frames by default', async () => {
    const result = await preprocessVideo(movingId);
    expect(result.keptFramesDir).toBeNull();
    for (const frame of result.selectedFrames) {
      await expect(access(frame.path)).rejects.toThrow();
    }
  }, 120_000);

  it('keeps frames on disk when asked to', async () => {
    const result = await preprocessVideo(movingId, {
      keepFrames: true,
      outputDir: debugDir,
    });

    expect(result.keptFramesDir).not.toBeNull();
    const files = await readdir(result.keptFramesDir!);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(result.extractedFrames);
  }, 120_000);

  it('builds a debug contact sheet from the selected frames', async () => {
    let sheetPath: string | null = null;

    await preprocessVideo(movingId, {
      beforeCleanup: async (pending) => {
        sheetPath = join(debugDir, 'sheet.jpg');
        await buildContactSheet(pending.selectedFrames, sheetPath);
      },
    });

    expect(sheetPath).not.toBeNull();
    await expect(access(sheetPath!)).resolves.toBeUndefined();
  }, 120_000);

  it('is deterministic across runs', async () => {
    const a = await preprocessVideo(movingId);
    const b = await preprocessVideo(movingId);
    expect(b.selectedFrames.map((f) => f.timestampSec)).toEqual(
      a.selectedFrames.map((f) => f.timestampSec),
    );
    expect(b.selectedFrames.map((f) => f.hash)).toEqual(a.selectedFrames.map((f) => f.hash));
  }, 180_000);

  it('fails clearly for an unknown video id', async () => {
    await expect(
      preprocessVideo('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(PreprocessError);
  }, 30_000);
});
