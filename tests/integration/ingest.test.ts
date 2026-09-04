import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { closeDb, db } from '../../src/db/client.ts';
import { videos } from '../../src/db/schema.ts';
import { DemoVideoSource } from '../../src/ingest/sources/demo.ts';
import { ingestFromSource } from '../../src/ingest/ingestService.ts';
import { deleteObject, objectExists, posterKey, videoKey } from '../../src/storage/s3.ts';
import type { IngestOutcome, IngestSummary } from '../../src/ingest/types.ts';

const execFileAsync = promisify(execFile);

/**
 * End-to-end ingestion against the real Postgres and MinIO from docker compose.
 *
 * Opt-in via TEST_INTEGRATION=1 so the default suite stays runnable with no
 * services up. Fixtures are generated with ffmpeg rather than committed, and every
 * row and object this file creates is removed afterwards.
 */
const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'itest_';
let dir: string;

async function makeVideo(name: string, width: number, height: number): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${width}x${height}:rate=10:duration=2`,
    '-pix_fmt',
    'yuv420p',
    '-y',
    join(dir, name),
  ]);
}

async function ingest(limit = 50): Promise<IngestSummary> {
  return ingestFromSource(new DemoVideoSource(dir, join(dir, 'manifest.json')), { limit });
}

const byId = (summary: IngestSummary, externalId: string): IngestOutcome => {
  const found = summary.outcomes.find((o) => o.externalId === externalId);
  if (!found) throw new Error(`No outcome for ${externalId}`);
  return found;
};

beforeAll(async () => {
  if (!enabled) return;
  dir = await mkdtemp(join(tmpdir(), 'ingest-integration-'));

  await makeVideo(`${PREFIX}portrait.mp4`, 180, 320);
  await makeVideo(`${PREFIX}landscape.mp4`, 320, 180);
  // Byte-identical to the portrait clip under a different name: same sha256.
  // Named to sort AFTER the original, since discovery is filename-ordered and
  // whichever file comes first is the one that wins the row.
  await copyFile(join(dir, `${PREFIX}portrait.mp4`), join(dir, `${PREFIX}portrait_copy.mp4`));
  // Valid extension, garbage contents - ffprobe must reject it.
  await writeFile(join(dir, `${PREFIX}broken.mp4`), Buffer.from('not a video at all'));

  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify([
      {
        file: `${PREFIX}portrait.mp4`,
        creatorId: 'creator_01',
        creatorHandle: 'demo_creator_01',
      },
      { file: 'never_present.mp4', creatorId: 'creator_99' },
    ]),
  );
}, 60_000);

afterAll(async () => {
  if (!enabled) return;

  const rows = await db
    .select({ id: videos.id, s3Key: videos.s3Key, thumbKey: videos.thumbKey })
    .from(videos)
    .where(like(videos.externalId, `${PREFIX}%`));

  for (const row of rows) {
    await deleteObject(row.s3Key).catch(() => {});
    if (row.thumbKey) await deleteObject(row.thumbKey).catch(() => {});
  }

  await db.delete(videos).where(like(videos.externalId, `${PREFIX}%`));
  await rm(dir, { recursive: true, force: true });
  await closeDb();
}, 60_000);

describe.skipIf(!enabled)('ingestion pipeline (integration)', () => {
  let first: IngestSummary;

  it('ingests portrait and landscape, rejects only the unreadable file', async () => {
    first = await ingest();

    expect(byId(first, `${PREFIX}portrait`).status).toBe('ingested');
    expect(byId(first, `${PREFIX}landscape`).status).toBe('ingested');
    expect(byId(first, `${PREFIX}broken`).status).toBe('rejected');
    expect(byId(first, `${PREFIX}broken`).reason).toBe('probe_failed');
  }, 60_000);

  it('flags landscape as a warning instead of refusing it', async () => {
    const landscape = byId(first, `${PREFIX}landscape`);
    expect(landscape.status).toBe('ingested');
    expect(landscape.warnings).toContain('not_vertical');
    expect(landscape.width).toBeGreaterThan(landscape.height!);

    // ...and portrait carries no warning.
    expect(byId(first, `${PREFIX}portrait`).warnings).toBeUndefined();
  });

  it('detects a byte-identical file as a duplicate within the same run', async () => {
    // Same sha256, different filename. The first file in discovery order owns the
    // row; the later one resolves to that same videoId rather than a second copy.
    const copy = byId(first, `${PREFIX}portrait_copy`);
    expect(copy.status).toBe('duplicate');
    expect(copy.videoId).toBe(byId(first, `${PREFIX}portrait`).videoId);
  });

  it('stores the video and its poster in object storage', async () => {
    const id = byId(first, `${PREFIX}portrait`).videoId!;
    expect(await objectExists(videoKey(id))).toBe(true);
    expect(await objectExists(posterKey(id))).toBe(true);
  }, 30_000);

  it('applies manifest attribution, leaving unlisted files null', async () => {
    const [portrait] = await db
      .select({ creatorId: videos.creatorId, creatorHandle: videos.creatorHandle })
      .from(videos)
      .where(eq(videos.id, byId(first, `${PREFIX}portrait`).videoId!));
    expect(portrait).toEqual({ creatorId: 'creator_01', creatorHandle: 'demo_creator_01' });

    const [landscape] = await db
      .select({ creatorId: videos.creatorId, creatorHandle: videos.creatorHandle })
      .from(videos)
      .where(eq(videos.id, byId(first, `${PREFIX}landscape`).videoId!));
    expect(landscape).toEqual({ creatorId: null, creatorHandle: null });
  });

  it('reports a manifest entry naming a file that is not present', () => {
    expect(first.unmatchedManifestEntries.join(' ')).toContain('never_present.mp4');
  });

  it('leaves ingested videos in the ingested state, with no analysis queued', async () => {
    const [row] = await db
      .select({ status: videos.status })
      .from(videos)
      .where(eq(videos.id, byId(first, `${PREFIX}portrait`).videoId!));
    expect(row?.status).toBe('ingested');
  });

  it('is idempotent: a second run adds nothing and reuses the same ids', async () => {
    const second = await ingest();

    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(3); // portrait, landscape, copy
    expect(second.rejected).toBe(1); // broken

    for (const name of [`${PREFIX}portrait`, `${PREFIX}landscape`]) {
      expect(byId(second, name).status).toBe('duplicate');
      expect(byId(second, name).videoId).toBe(byId(first, name).videoId);
    }
  }, 60_000);

  it('backfills creator attribution onto an existing row that has none', async () => {
    const landscapeId = byId(first, `${PREFIX}landscape`).videoId!;

    // Ingested with no manifest entry, so attribution starts null.
    const [before] = await db
      .select({ creatorId: videos.creatorId })
      .from(videos)
      .where(eq(videos.id, landscapeId));
    expect(before?.creatorId).toBeNull();

    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify([
        {
          file: `${PREFIX}portrait.mp4`,
          creatorId: 'creator_01',
          creatorHandle: 'demo_creator_01',
        },
        {
          file: `${PREFIX}landscape.mp4`,
          creatorId: 'creator_02',
          creatorHandle: 'demo_creator_02',
        },
        { file: 'never_present.mp4', creatorId: 'creator_99' },
      ]),
    );

    const enrichRun = await ingest();
    expect(byId(enrichRun, `${PREFIX}landscape`).status).toBe('duplicate');
    expect(byId(enrichRun, `${PREFIX}landscape`).creatorEnriched).toBe(true);

    const [after] = await db
      .select({ creatorId: videos.creatorId, creatorHandle: videos.creatorHandle })
      .from(videos)
      .where(eq(videos.id, landscapeId));
    expect(after).toEqual({ creatorId: 'creator_02', creatorHandle: 'demo_creator_02' });

    // ...and a further run changes nothing: enrichment is itself idempotent.
    const settled = await ingest();
    expect(byId(settled, `${PREFIX}landscape`).creatorEnriched).toBeUndefined();
    expect(byId(settled, `${PREFIX}landscape`).warnings).toBeUndefined();
  }, 60_000);

  it('never silently overwrites existing attribution, reporting a conflict instead', async () => {
    const landscapeId = byId(first, `${PREFIX}landscape`).videoId!;

    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify([
        { file: `${PREFIX}landscape.mp4`, creatorId: 'someone_else', creatorHandle: 'other' },
      ]),
    );

    const conflictRun = await ingest();
    const outcome = byId(conflictRun, `${PREFIX}landscape`);
    expect(outcome.warnings).toContain('creator_conflict');
    expect(outcome.creatorEnriched).toBeUndefined();
    expect(outcome.detail).toContain('left unchanged');

    const [row] = await db
      .select({ creatorId: videos.creatorId })
      .from(videos)
      .where(eq(videos.id, landscapeId));
    expect(row?.creatorId).toBe('creator_02');
  }, 60_000);

  it('exposes filename -> videoId on a duplicate run, for the gold dataset', async () => {
    const second = await ingest();
    const mapping = Object.fromEntries(
      second.outcomes.filter((o) => o.videoId).map((o) => [o.fileName, o.videoId]),
    );
    expect(mapping[`${PREFIX}portrait.mp4`]).toBe(byId(first, `${PREFIX}portrait`).videoId);
    expect(mapping[`${PREFIX}landscape.mp4`]).toBe(byId(first, `${PREFIX}landscape`).videoId);
  }, 60_000);
});
