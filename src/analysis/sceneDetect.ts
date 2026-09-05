import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env.ts';

const execFileAsync = promisify(execFile);

/**
 * Optional scene-cut detection, OFF by default.
 *
 * The tradeoff, stated plainly: finding cuts requires ffmpeg to decode every frame
 * of the video and compare consecutive ones. That is precisely the cost adaptive
 * sampling exists to avoid - the pipeline's central claim is that it never decodes
 * a whole video. Enabling this roughly doubles preprocessing time and would be the
 * dominant CPU cost at 100k videos.
 *
 * What it buys is modest: uniform sampling on short-form vertical video already
 * lands frames across the shots that matter, because reels are short and cuts are
 * frequent. Scene awareness mainly helps a long video with one abrupt change.
 *
 * So it exists, it is tested, and it is a flag - not the default. When enabled it
 * only *nudges* uniform timestamps toward nearby cuts (see snapToScenes); it never
 * replaces the plan with the cut list, which on a fast-cut video would overshoot
 * the frame budget.
 */
export async function detectSceneChanges(
  videoPath: string,
  threshold: number = env.SCENE_THRESHOLD,
): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-i',
        videoPath,
        '-filter:v',
        `select='gt(scene,${threshold})',showinfo`,
        '-f',
        'null',
        '-',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );

    return parseShowinfoTimestamps(stderr);
  } catch {
    // Scene detection is an enhancement; failing it must not fail the video.
    return [];
  }
}

/** Pulls `pts_time:` values out of ffmpeg's showinfo output on stderr. */
export function parseShowinfoTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const pattern = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) timestamps.push(value);
  }

  return timestamps.sort((a, b) => a - b);
}
