import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import { videos } from '../db/schema.ts';
import { FfprobeError, isVertical, probeVideo, type VideoMetadata } from '../analysis/ffprobe.ts';
import { posterKey, putObject, videoKey } from '../storage/s3.ts';
import { analysisQueue } from '../queue/queues.ts';
import { extractPosterFrame } from './poster.ts';
import type {
  IngestOutcome,
  IngestSummary,
  IngestWarning,
  RejectionReason,
  SourceItem,
  VideoSource,
} from './types.ts';

/**
 * Source-agnostic ingestion pipeline.
 *
 *   item -> bytes -> sha256 -> dedup -> ffprobe -> validate
 *        -> upload video -> poster -> videos row -> enqueue analysis
 *
 * Ordering is deliberate. Probing and validating happen BEFORE the upload, so a
 * landscape or over-long video never costs an object-storage write. Content is
 * hashed before anything else, so a re-run is idempotent without touching S3 at
 * all.
 */

export interface IngestOptions {
  limit: number;
  /**
   * Enqueue an analysis job per ingested video. Off by default: ingestion ends at
   * a stored, `ingested` row. Wiring analysis onto the back of ingestion belongs
   * with the analysis milestone, and leaving jobs queued for a worker that does
   * not exist yet is state without an owner.
   */
  enqueue?: boolean;
  onProgress?: (outcome: IngestOutcome) => void;
}

function rejection(
  item: SourceItem,
  reason: RejectionReason,
  detail: string,
  metadata?: VideoMetadata,
): IngestOutcome {
  return {
    externalId: item.externalId,
    fileName: item.fileName,
    status: 'rejected',
    reason,
    detail,
    durationSeconds: metadata?.durationSeconds,
    width: metadata?.width,
    height: metadata?.height,
  };
}

/** Reads a local file, or downloads a remote one into a temp dir. */
async function materialise(item: SourceItem): Promise<{ bytes: Buffer; cleanup: () => Promise<void> }> {
  if (item.localPath) {
    return { bytes: await readFile(item.localPath), cleanup: async () => {} };
  }

  if (!item.mediaUrl) {
    throw new Error(`Source item ${item.externalId} has neither localPath nor mediaUrl`);
  }

  const response = await fetch(item.mediaUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${item.mediaUrl}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  const path = join(dir, 'video.mp4');
  await writeFile(path, bytes);

  return {
    bytes,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

interface ExistingVideo {
  id: string;
  creatorId: string | null;
  creatorHandle: string | null;
}

/**
 * Backfills creator attribution onto a row that already exists.
 *
 * The corpus is normally ingested before a manifest is written, so without this a
 * manifest added later would never take effect - re-running would just report 30
 * duplicates and change nothing.
 *
 * Only ever fills nulls. An existing non-null value is left alone and reported as a
 * conflict: silently rewriting attribution would make the database disagree with
 * whatever produced the original value, with no record that it happened.
 */
async function reconcileCreator(
  existing: ExistingVideo,
  item: SourceItem,
): Promise<{ enriched: boolean; conflict: string | null }> {
  const wantedId = item.creatorId ?? null;
  const wantedHandle = item.creatorHandle ?? null;

  if (wantedId === null && wantedHandle === null) {
    return { enriched: false, conflict: null };
  }

  const alreadyAttributed = existing.creatorId !== null || existing.creatorHandle !== null;

  if (!alreadyAttributed) {
    await db
      .update(videos)
      .set({ creatorId: wantedId, creatorHandle: wantedHandle })
      .where(eq(videos.id, existing.id));
    return { enriched: true, conflict: null };
  }

  // Already matches - the second run of an enriched corpus, i.e. a no-op.
  if (existing.creatorId === wantedId && existing.creatorHandle === wantedHandle) {
    return { enriched: false, conflict: null };
  }

  return {
    enriched: false,
    conflict:
      `row has ${existing.creatorId ?? 'null'}/${existing.creatorHandle ?? 'null'}, ` +
      `manifest says ${wantedId ?? 'null'}/${wantedHandle ?? 'null'} (left unchanged)`,
  };
}

async function ingestItem(
  item: SourceItem,
  source: VideoSource,
  enqueue: boolean,
): Promise<IngestOutcome> {
  let bytes: Buffer;
  let cleanup: () => Promise<void> = async () => {};
  let workingPath: string;
  let tempDir: string | undefined;

  try {
    const materialised = await materialise(item);
    bytes = materialised.bytes;
    cleanup = materialised.cleanup;

    if (item.localPath) {
      workingPath = item.localPath;
    } else {
      tempDir = await mkdtemp(join(tmpdir(), 'ingest-probe-'));
      workingPath = join(tempDir, 'video.mp4');
      await writeFile(workingPath, bytes);
    }
  } catch (error) {
    await cleanup();
    return {
      externalId: item.externalId,
      status: 'rejected',
      reason: item.localPath ? 'unreadable' : 'download_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    // Content hash first: a re-run must be a no-op without any S3 or ffmpeg work.
    const checksum = createHash('sha256').update(bytes).digest('hex');

    const [existing] = await db
      .select({
        id: videos.id,
        creatorId: videos.creatorId,
        creatorHandle: videos.creatorHandle,
      })
      .from(videos)
      .where(eq(videos.checksum, checksum))
      .limit(1);

    if (existing) {
      const { enriched, conflict } = await reconcileCreator(existing, item);

      // The id is returned so a re-run still yields a filename -> UUID mapping
      // without anyone having to query Postgres by hand.
      return {
        externalId: item.externalId,
        fileName: item.fileName,
        status: 'duplicate',
        videoId: existing.id,
        creatorEnriched: enriched || undefined,
        warnings: conflict ? ['creator_conflict'] : undefined,
        detail: conflict ?? undefined,
      };
    }

    let metadata: VideoMetadata;
    try {
      metadata = await probeVideo(workingPath);
    } catch (error) {
      return {
        externalId: item.externalId,
        fileName: item.fileName,
        status: 'rejected',
        reason: 'probe_failed',
        detail: error instanceof FfprobeError ? error.message : String(error),
      };
    }

    // Aspect ratio is a warning, never a rejection. A landscape video is still a
    // valid video; whether the feed wants to show it is a presentation decision
    // made later, not a reason to refuse it at the storage boundary.
    const warnings: IngestWarning[] = [];
    if (!isVertical(metadata)) warnings.push('not_vertical');

    if (metadata.durationSeconds > env.INGEST_MAX_DURATION_SECONDS) {
      return rejection(
        item,
        'too_long',
        `${metadata.durationSeconds.toFixed(1)}s exceeds ${env.INGEST_MAX_DURATION_SECONDS}s`,
        metadata,
      );
    }
    if (metadata.durationSeconds < env.INGEST_MIN_DURATION_SECONDS) {
      return rejection(
        item,
        'too_short',
        `${metadata.durationSeconds.toFixed(1)}s is below ${env.INGEST_MIN_DURATION_SECONDS}s`,
        metadata,
      );
    }

    const id = randomUUID();

    await putObject(videoKey(id), bytes, 'video/mp4');

    // A missing poster degrades the feed's appearance but is not worth failing an
    // otherwise good video over.
    let thumbKey: string | null = null;
    try {
      const poster = await extractPosterFrame(workingPath, metadata.durationSeconds);
      await putObject(posterKey(id), poster, 'image/jpeg');
      thumbKey = posterKey(id);
    } catch {
      thumbKey = null;
    }

    await db.insert(videos).values({
      id,
      source: source.name,
      sourceUrl: item.pageUrl ?? null,
      externalId: item.externalId,
      creatorId: item.creatorId ?? null,
      creatorHandle: item.creatorHandle ?? null,
      s3Key: videoKey(id),
      thumbKey,
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      sizeBytes: bytes.byteLength,
      checksum,
      status: 'ingested',
    });

    if (enqueue) {
      await analysisQueue().add('analyze', { videoId: id }, { jobId: id });
    }

    return {
      externalId: item.externalId,
      fileName: item.fileName,
      status: 'ingested',
      videoId: id,
      warnings: warnings.length > 0 ? warnings : undefined,
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    return {
      externalId: item.externalId,
      fileName: item.fileName,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cleanup();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export async function ingestFromSource(
  source: VideoSource,
  options: IngestOptions,
): Promise<IngestSummary> {
  const outcomes: IngestOutcome[] = [];

  for await (const item of source.discover(options.limit)) {
    const outcome = await ingestItem(item, source, options.enqueue ?? false);
    outcomes.push(outcome);
    options.onProgress?.(outcome);
  }

  return {
    source: source.name,
    ingested: outcomes.filter((o) => o.status === 'ingested').length,
    duplicates: outcomes.filter((o) => o.status === 'duplicate').length,
    rejected: outcomes.filter((o) => o.status === 'rejected').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
    unmatchedManifestEntries: source.warnings?.() ?? [],
  };
}
