import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFrames, scaledDimensions } from '../../src/analysis/frames.ts';
import { parseShowinfoTimestamps } from '../../src/analysis/sceneDetect.ts';
import { hammingDistance } from '../../src/analysis/dhash.ts';

const execFileAsync = promisify(execFile);

describe('scaledDimensions', () => {
  it('never upscales a source smaller than the limit', () => {
    // Interpolated pixels cost tokens and carry no extra information.
    expect(scaledDimensions(360, 640, 768)).toEqual({ width: 360, height: 640, scaled: false });
    expect(scaledDimensions(464, 768, 768)).toEqual({ width: 464, height: 768, scaled: false });
  });

  it('scales a source whose long edge exceeds the limit, even if narrow', () => {
    // 464x848: the width is small but the height is over the cap, so it scales.
    const result = scaledDimensions(464, 848, 768);
    expect(result.scaled).toBe(true);
    expect(result.height).toBe(768);
  });

  it('scales the long edge down to the limit', () => {
    const result = scaledDimensions(720, 1280, 768);
    expect(result.scaled).toBe(true);
    expect(Math.max(result.width, result.height)).toBe(768);
  });

  it('preserves aspect ratio within rounding', () => {
    const result = scaledDimensions(720, 1280, 768);
    expect(result.width / result.height).toBeCloseTo(720 / 1280, 2);
  });

  it('produces even dimensions, which encoders require', () => {
    for (const [w, h] of [
      [721, 1281],
      [1280, 720],
      [1079, 1919],
    ] as const) {
      const result = scaledDimensions(w, h, 768);
      expect(result.width % 2).toBe(0);
      expect(result.height % 2).toBe(0);
    }
  });

  it('handles landscape as well as portrait', () => {
    const result = scaledDimensions(1280, 720, 768);
    expect(result.width).toBe(768);
  });
});

describe('parseShowinfoTimestamps', () => {
  it('extracts ascending pts_time values from ffmpeg stderr', () => {
    const stderr = [
      '[Parsed_showinfo_1 @ 0x1] n:0 pts:1234 pts_time:12.5 pos:1',
      '[Parsed_showinfo_1 @ 0x1] n:1 pts:2345 pts_time:3.25 pos:2',
    ].join('\n');
    expect(parseShowinfoTimestamps(stderr)).toEqual([3.25, 12.5]);
  });

  it('returns nothing when no cuts were reported', () => {
    expect(parseShowinfoTimestamps('no scene changes here')).toEqual([]);
  });
});

/** ffmpeg-backed extraction against a generated fixture. */
let available = false;
let dir: string;
let videoPath: string;

beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    available = true;
  } catch {
    return;
  }

  dir = await mkdtemp(join(tmpdir(), 'frames-test-'));
  videoPath = join(dir, 'source.mp4');

  // testsrc changes continuously, so consecutive frames are genuinely different.
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=240x426:rate=25:duration=6',
    '-pix_fmt',
    'yuv420p',
    '-y',
    videoPath,
  ]);
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!available)('extractFrames (ffmpeg)', () => {
  it('writes one JPEG per timestamp and hashes each', async () => {
    const outputDir = join(dir, 'out1');
    await mkdir(outputDir, { recursive: true });

    const frames = await extractFrames(videoPath, [1, 2.5, 4], outputDir, {
      width: 240,
      height: 426,
    });

    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(frame.path.endsWith('.jpg')).toBe(true);
    }
    expect((await readdir(outputDir)).filter((f) => f.endsWith('.jpg'))).toHaveLength(3);
  }, 60_000);

  it('preserves the requested timestamps on the returned frames', async () => {
    const outputDir = join(dir, 'out2');
    await mkdir(outputDir, { recursive: true });

    const requested = [0.5, 3];
    const frames = await extractFrames(videoPath, requested, outputDir, {
      width: 240,
      height: 426,
    });
    expect(frames.map((f) => f.timestampSec)).toEqual(requested);
  }, 60_000);

  it('gives different hashes to visibly different frames', async () => {
    const outputDir = join(dir, 'out3');
    await mkdir(outputDir, { recursive: true });

    const frames = await extractFrames(videoPath, [0.5, 5.5], outputDir, {
      width: 240,
      height: 426,
    });
    expect(hammingDistance(frames[0]!.hash, frames[1]!.hash)).toBeGreaterThan(0);
  }, 60_000);

  it('skips a timestamp beyond the end rather than failing the video', async () => {
    const outputDir = join(dir, 'out4');
    await mkdir(outputDir, { recursive: true });

    const frames = await extractFrames(videoPath, [1, 9999], outputDir, {
      width: 240,
      height: 426,
    });
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.every((f) => f.hash.length === 16)).toBe(true);
  }, 60_000);

  it('returns nothing for a missing input file', async () => {
    const outputDir = join(dir, 'out5');
    await mkdir(outputDir, { recursive: true });

    const frames = await extractFrames(join(dir, 'nope.mp4'), [1], outputDir, {
      width: 240,
      height: 426,
    });
    expect(frames).toEqual([]);
  }, 60_000);
});
