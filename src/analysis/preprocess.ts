import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import { videos } from '../db/schema.ts';
import { getObjectToFile } from '../storage/s3.ts';
import { probeVideo } from './ffprobe.ts';
import { frameBudgetFor, planTimestamps, snapToScenes } from './sampling.ts';
import { dedupeByHash } from './dhash.ts';
import { extractFrames } from './frames.ts';
import { detectSceneChanges } from './sceneDetect.ts';

/**
 * Preprocessing: video -> a small, representative, de-duplicated set of frames.
 *
 *   S3 object -> temp file -> ffprobe -> timestamp plan -> extract -> dHash
 *             -> drop near-duplicates -> SampledFrame[]
 *
 * Deliberately knows nothing about any vision model. A VisionProvider will consume
 * `selectedFrames` and nothing else, so the model can be chosen, benchmarked or
 * swapped without touching a line of this.
 */

export interface SampledFrame {
  timestampSec: number;
  path: string;
  hash?: string;
}

export interface VideoPreprocessResult {
  videoId: string;
  externalId: string | null;
  durationSec: number;
  width: number;
  height: number;
  /** Frames the budget asked for, before extraction. */
  requestedFrames: number;
  /** Frames ffmpeg actually produced. */
  extractedFrames: number;
  /** Frames dropped as near-duplicates. */
  removedDuplicates: number;
  selectedFrames: SampledFrame[];
  sceneChangesDetected: number | null;
  processingMs: number;
  /** Directory holding the frames, when they were kept; otherwise null. */
  keptFramesDir: string | null;
}

export interface PreprocessOptions {
  /** Keep extracted frames on disk instead of deleting them. Debug only. */
  keepFrames?: boolean;
  /** Where kept frames and contact sheets go. */
  outputDir?: string;
  /** Decode the whole video to find cuts. Costly; see sceneDetect.ts. */
  sceneAware?: boolean;
  /**
   * Called before temporary files are removed, so a caller can build a contact
   * sheet while the frames still exist.
   */
  beforeCleanup?: (result: VideoPreprocessResult) => Promise<void>;
}

export class PreprocessError extends Error {}

export async function preprocessVideo(
  videoId: string,
  options: PreprocessOptions = {},
): Promise<VideoPreprocessResult> {
  const startedAt = Date.now();

  const [video] = await db
    .select({
      id: videos.id,
      externalId: videos.externalId,
      s3Key: videos.s3Key,
      durationSeconds: videos.durationSeconds,
      width: videos.width,
      height: videos.height,
    })
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1);

  if (!video) throw new PreprocessError(`No video with id ${videoId}`);

  const keepFrames = options.keepFrames ?? false;
  const workDir = await mkdtemp(join(tmpdir(), 'preprocess-'));
  const videoPath = join(workDir, 'source.mp4');

  let framesDir = join(workDir, 'frames');
  if (keepFrames) {
    framesDir = join(options.outputDir ?? env.PREPROCESS_DEBUG_DIR, 'frames', videoId);
  }
  await mkdir(framesDir, { recursive: true });

  try {
    await getObjectToFile(video.s3Key, videoPath);

    // Re-probe rather than trusting the stored row: preprocessing must be correct
    // against the bytes it is actually about to sample.
    const metadata = await probeVideo(videoPath);

    const requestedFrames = frameBudgetFor(metadata.durationSeconds);
    let timestamps = planTimestamps(metadata.durationSeconds, requestedFrames);

    let sceneChangesDetected: number | null = null;
    if (options.sceneAware ?? env.SAMPLING_SCENE_AWARE) {
      const cuts = await detectSceneChanges(videoPath);
      sceneChangesDetected = cuts.length;
      timestamps = snapToScenes(timestamps, cuts);
    }

    const extracted = await extractFrames(videoPath, timestamps, framesDir, {
      width: metadata.width,
      height: metadata.height,
    });

    // A frame whose hash could not be computed cannot participate in duplicate
    // detection; keeping it would let an unbounded number of identical frames
    // through, so it is dropped.
    const hashed = extracted.filter((frame) => frame.hash.length > 0);
    const { kept, removed } = dedupeByHash(hashed);

    const result: VideoPreprocessResult = {
      videoId: video.id,
      externalId: video.externalId,
      durationSec: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      requestedFrames,
      extractedFrames: extracted.length,
      removedDuplicates: removed.length,
      selectedFrames: kept.map((frame) => ({
        timestampSec: frame.timestampSec,
        path: frame.path,
        hash: frame.hash,
      })),
      sceneChangesDetected,
      processingMs: Date.now() - startedAt,
      keptFramesDir: keepFrames ? framesDir : null,
    };

    // Runs while the frames still exist - a contact sheet needs them.
    await options.beforeCleanup?.(result);

    return result;
  } finally {
    // Sampled frames are analysis artefacts, not stored media. The only frame the
    // system keeps permanently is the poster written at ingestion.
    await rm(videoPath, { force: true });
    if (!keepFrames) await rm(framesDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Video ids eligible for preprocessing, oldest first. */
export async function listPreprocessableVideoIds(limit?: number): Promise<string[]> {
  const rows = await db
    .select({ id: videos.id, externalId: videos.externalId })
    .from(videos)
    .orderBy(videos.externalId);

  const ids = rows.map((row) => row.id);
  return limit === undefined ? ids : ids.slice(0, limit);
}
