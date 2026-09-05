import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.ts';
import { HASH_BYTES, HASH_HEIGHT, HASH_WIDTH, dHashFromGray } from './dhash.ts';

const execFileAsync = promisify(execFile);

export interface ExtractedFrame {
  timestampSec: number;
  path: string;
  /** Position in the extraction sequence, used for deterministic filenames. */
  index: number;
  hash: string;
}

/**
 * Target dimensions that never upscale.
 *
 * Enlarging a 464x848 clip to 768 on the long edge would cost more tokens for
 * pixels that carry no extra information - the model sees interpolation, not
 * detail. Both dimensions are forced even because several encoders reject odd ones.
 */
export function scaledDimensions(
  width: number,
  height: number,
  maxLongEdge: number = env.FRAME_MAX_LONG_EDGE,
): { width: number; height: number; scaled: boolean } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height, scaled: false };

  const factor = maxLongEdge / longEdge;
  const even = (value: number): number => Math.max(2, Math.round((value * factor) / 2) * 2);
  return { width: even(width), height: even(height), scaled: true };
}

/**
 * Extracts one JPEG per timestamp.
 *
 * One ffmpeg invocation per frame with a seek before `-i`: that seek form jumps to
 * the nearest keyframe without decoding what precedes it, which is the whole point
 * of sampling. A single-pass `select` filter over the same timestamps would decode
 * the entire video to reach them.
 *
 * A timestamp that fails to yield a frame is skipped rather than failing the video:
 * a truncated or slightly corrupt tail is common, and losing one of eight frames is
 * not worth discarding the analysis.
 */
export async function extractFrames(
  videoPath: string,
  timestamps: readonly number[],
  outputDir: string,
  dimensions: { width: number; height: number },
): Promise<ExtractedFrame[]> {
  const target = scaledDimensions(dimensions.width, dimensions.height);
  const extracted: { timestampSec: number; path: string; index: number }[] = [];

  for (const timestampSec of timestamps) {
    // Numbered contiguously over SUCCESSFUL extractions so the hashing pass can
    // read them as an unbroken image sequence.
    const index = extracted.length + 1;
    const path = join(outputDir, `frame_${String(index).padStart(3, '0')}.jpg`);

    const filters = target.scaled ? ['-vf', `scale=${target.width}:${target.height}`] : [];

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          timestampSec.toFixed(3),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          ...filters,
          '-q:v',
          String(env.FRAME_JPEG_QUALITY),
          '-y',
          path,
        ],
        { maxBuffer: 8 * 1024 * 1024 },
      );

      const info = await stat(path);
      if (info.size > 0) extracted.push({ timestampSec, path, index });
      else await rm(path, { force: true });
    } catch {
      await rm(path, { force: true });
    }
  }

  const hashes = await hashFrameSequence(outputDir, extracted.length);

  return extracted.map((frame, i) => ({
    ...frame,
    hash: hashes[i] ?? '',
  }));
}

/**
 * Hashes every extracted frame in a single ffmpeg pass.
 *
 * Reads the JPEGs back as an image sequence and emits one 9x8 grayscale buffer per
 * frame on stdout. One process for the whole set instead of one per frame - on a
 * 30-video corpus that is ~30 invocations rather than ~350.
 */
async function hashFrameSequence(directory: string, count: number): Promise<string[]> {
  if (count === 0) return [];

  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-start_number',
      '1',
      '-i',
      join(directory, 'frame_%03d.jpg'),
      '-vf',
      `scale=${HASH_WIDTH}:${HASH_HEIGHT},format=gray`,
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
  );

  const buffer = stdout as unknown as Buffer;
  const hashes: string[] = [];

  for (let i = 0; i < count; i++) {
    const slice = buffer.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES);
    // A short read means ffmpeg produced fewer planes than expected; an empty hash
    // is filtered out by the caller rather than crashing the run.
    hashes.push(slice.length === HASH_BYTES ? dHashFromGray(slice) : '');
  }

  return hashes;
}
