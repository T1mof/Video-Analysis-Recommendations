import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * FFprobe metadata - the first step of the analysis pipeline and the gate for
 * ingestion. Everything downstream (frame budget, sampling grid, vertical filter)
 * is derived from these numbers, so they are read once and carried along rather
 * than re-probed.
 */
export interface VideoMetadata {
  durationSeconds: number;
  /** Display width, i.e. after any container rotation is applied. */
  width: number;
  /** Display height, i.e. after any container rotation is applied. */
  height: number;
  fps: number | null;
  codec: string | null;
  hasAudio: boolean;
  /** Container rotation in degrees, normalised to 0/90/180/270. */
  rotationDegrees: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
  rotation?: number | string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export class FfprobeError extends Error {}

/** Parses ffprobe's "30000/1001" rational frame rate into a number. */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  const fps = n / d;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/**
 * Rotation can arrive in three different places depending on how the file was
 * muxed. Phone-shot vertical video is very often stored as a landscape frame plus
 * a 90 degree rotation flag, so missing this would reject genuinely vertical
 * videos at the ingestion gate.
 */
function readRotation(stream: FfprobeStream): number {
  const raw =
    stream.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ??
    stream.rotation ??
    stream.tags?.rotate;

  const degrees = Number(raw ?? 0);
  if (!Number.isFinite(degrees)) return 0;
  return ((Math.round(degrees) % 360) + 360) % 360;
}

/**
 * Display dimensions after container rotation. Exported separately from probing so
 * the rotation rule can be tested without a video file.
 */
export function displayDimensions(
  width: number,
  height: number,
  rotationDegrees: number,
): { width: number; height: number } {
  const normalised = ((Math.round(rotationDegrees) % 360) + 360) % 360;
  const swapped = normalised === 90 || normalised === 270;
  return swapped ? { width: height, height: width } : { width, height };
}

export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,r_frame_rate,duration,rotation:stream_side_data=rotation:stream_tags=rotate:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FfprobeError(`ffprobe failed for ${filePath}: ${message}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new FfprobeError(`ffprobe returned unparseable JSON for ${filePath}`);
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new FfprobeError(`No video stream in ${filePath}`);

  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new FfprobeError(`Missing frame dimensions in ${filePath}`);
  }

  const duration = Number(parsed.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new FfprobeError(`Missing or invalid duration in ${filePath}`);
  }

  const rotationDegrees = readRotation(video);
  const display = displayDimensions(width, height, rotationDegrees);

  return {
    durationSeconds: duration,
    width: display.width,
    height: display.height,
    fps: parseFrameRate(video.r_frame_rate),
    codec: video.codec_name ?? null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    rotationDegrees,
  };
}

export function isVertical(metadata: Pick<VideoMetadata, 'width' | 'height'>): boolean {
  return metadata.height > metadata.width;
}

export function aspectRatio(metadata: Pick<VideoMetadata, 'width' | 'height'>): number {
  return metadata.width / metadata.height;
}
