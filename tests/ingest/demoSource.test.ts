import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoVideoSource } from '../../src/ingest/sources/demo.ts';
import type { SourceItem } from '../../src/ingest/types.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'demo-source-'));
  // Deliberately out of order, with non-video files mixed in.
  for (const name of [
    'video_10.mp4',
    'video_02.MP4',
    'video_01.mp4',
    'clip.mov',
    'notes.txt',
    'poster.jpg',
    '.DS_Store',
  ]) {
    await writeFile(join(dir, name), 'x');
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function collect(limit: number): Promise<SourceItem[]> {
  const items: SourceItem[] = [];
  for await (const item of new DemoVideoSource(dir).discover(limit)) items.push(item);
  return items;
}

describe('DemoVideoSource', () => {
  it('yields only video files, ignoring other content in the directory', async () => {
    const names = (await collect(100)).map((i) => i.externalId);
    // Sorted by filename, so clip.mov precedes video_*.mp4.
    expect(names).toEqual(['clip', 'video_01', 'video_02', 'video_10']);
  });

  it('is case-insensitive about extensions', async () => {
    // video_02.MP4 - a corpus assembled by hand will not be tidy.
    expect((await collect(100)).map((i) => i.externalId)).toContain('video_02');
  });

  it('orders deterministically so re-runs ingest in the same order', async () => {
    expect((await collect(100)).map((i) => i.externalId)).toEqual(
      (await collect(100)).map((i) => i.externalId),
    );
  });

  it('respects the limit', async () => {
    expect(await collect(2)).toHaveLength(2);
  });

  it('reports null creator attribution rather than inventing one', async () => {
    const [first] = await collect(1);
    expect(first?.creatorId).toBeNull();
    expect(first?.creatorHandle).toBeNull();
  });

  it('points at a real local path', async () => {
    const item = (await collect(100)).find((i) => i.externalId === 'video_01');
    expect(item?.localPath).toBe(join(dir, 'video_01.mp4'));
    expect(item?.mediaUrl).toBeUndefined();
  });

  it('fails with an actionable message when the directory does not exist', async () => {
    const missing = new DemoVideoSource(join(dir, 'nope'));
    await expect(async () => {
      for await (const _ of missing.discover(1)) void _;
    }).rejects.toThrow(/Cannot read demo source directory/);
  });
});
