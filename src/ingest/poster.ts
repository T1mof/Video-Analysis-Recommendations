import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env.ts';

const execFileAsync = promisify(execFile);

/**
 * Extracts one representative still for the feed.
 *
 * Taken a short way into the video rather than at t=0: the first frame of a reel
 * is very often black, a fade-in, or a title card, none of which say anything about
 * the content.
 *
 * This is the ONLY frame kept permanently. The frames used for VLM analysis are
 * temporary artefacts and are deleted after the model call.
 */
export async function extractPosterFrame(
  videoPath: string,
  durationSeconds: number,
): Promise<Buffer> {
  const seek = Math.min(
    Math.max(durationSeconds * env.POSTER_POSITION_PCT, 0),
    Math.max(durationSeconds - 0.1, 0),
  );

  const dir = await mkdtemp(join(tmpdir(), 'poster-'));
  const outputPath = join(dir, 'poster.jpg');

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        // Seeking before -i is the fast path; accurate enough for a thumbnail.
        '-ss',
        seek.toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${env.POSTER_WIDTH}:-2`,
        '-q:v',
        '4',
        '-y',
        outputPath,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );

    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
