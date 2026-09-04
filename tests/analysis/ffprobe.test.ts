import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aspectRatio,
  displayDimensions,
  isVertical,
  probeVideo,
} from '../../src/analysis/ffprobe.ts';
import { env } from '../../src/config/env.ts';

describe('isVertical', () => {
  it('accepts portrait and rejects landscape and square', () => {
    expect(isVertical({ width: 720, height: 1280 })).toBe(true);
    expect(isVertical({ width: 1280, height: 720 })).toBe(false);
    // Square is not vertical: the feed is a portrait surface.
    expect(isVertical({ width: 1080, height: 1080 })).toBe(false);
  });
});

describe('aspectRatio', () => {
  it('is below 1 for portrait', () => {
    expect(aspectRatio({ width: 720, height: 1280 })).toBeCloseTo(0.5625, 4);
  });
});

describe('displayDimensions', () => {
  it('leaves unrotated video alone', () => {
    expect(displayDimensions(720, 1280, 0)).toEqual({ width: 720, height: 1280 });
    expect(displayDimensions(1280, 720, 180)).toEqual({ width: 1280, height: 720 });
  });

  it('swaps axes at 90 and 270 degrees', () => {
    // Phone-shot vertical video is routinely stored as a landscape frame plus a
    // rotation flag. Without the swap it would look landscape to everything
    // downstream, including the feed layout.
    expect(displayDimensions(1280, 720, 90)).toEqual({ width: 720, height: 1280 });
    expect(displayDimensions(1280, 720, 270)).toEqual({ width: 720, height: 1280 });
  });

  it('normalises negative and over-360 rotations', () => {
    expect(displayDimensions(1280, 720, -90)).toEqual({ width: 720, height: 1280 });
    expect(displayDimensions(1280, 720, 450)).toEqual({ width: 720, height: 1280 });
    expect(displayDimensions(1280, 720, -180)).toEqual({ width: 1280, height: 720 });
  });

  it('makes a rotated landscape frame read as vertical', () => {
    expect(isVertical(displayDimensions(1280, 720, 90))).toBe(true);
    expect(isVertical(displayDimensions(1280, 720, 0))).toBe(false);
  });
});

/**
 * Runs against the real corpus when it is present. The seed directory is
 * gitignored (local 18+ content is never committed), so on a clean clone these
 * skip rather than fail.
 */
const seedDir = env.DEMO_SOURCE_DIR;
const seedFiles = existsSync(seedDir)
  ? readdirSync(seedDir).filter((f) => f.toLowerCase().endsWith('.mp4'))
  : [];

describe.skipIf(seedFiles.length === 0)('probeVideo against the real corpus', () => {
  it('reads duration and display dimensions', async () => {
    const metadata = await probeVideo(join(seedDir, seedFiles[0]!));
    expect(metadata.durationSeconds).toBeGreaterThan(0);
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
    expect([0, 90, 180, 270]).toContain(metadata.rotationDegrees);
  });

  it('reports a plausible frame rate', async () => {
    const metadata = await probeVideo(join(seedDir, seedFiles[0]!));
    expect(metadata.fps === null || (metadata.fps > 0 && metadata.fps < 240)).toBe(true);
  });

  it('rejects a file that is not a video', async () => {
    await expect(probeVideo(join(seedDir, 'definitely-missing.mp4'))).rejects.toThrow();
  });
});
