import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManifestError, loadManifest } from '../../src/ingest/manifest.ts';

let dir: string;
const at = (name: string): string => join(dir, name);

async function write(name: string, contents: string): Promise<string> {
  await writeFile(at(name), contents);
  return at(name);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'manifest-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadManifest', () => {
  it('treats a missing file as normal and returns empty attribution', async () => {
    const manifest = await loadManifest(at('does-not-exist.json'));
    expect(manifest.present).toBe(false);
    expect(manifest.size).toBe(0);
    expect(manifest.get('video_01.mp4')).toEqual({ creatorId: null, creatorHandle: null });
  });

  it('maps filenames to creator attribution', async () => {
    const path = await write(
      'good.json',
      JSON.stringify([
        { file: 'video_01.mp4', creatorId: 'creator_01', creatorHandle: 'demo_creator_01' },
        { file: 'video_02.mp4', creatorId: 'creator_02', creatorHandle: 'demo_creator_02' },
      ]),
    );
    const manifest = await loadManifest(path);

    expect(manifest.present).toBe(true);
    expect(manifest.size).toBe(2);
    expect(manifest.get('video_01.mp4')).toEqual({
      creatorId: 'creator_01',
      creatorHandle: 'demo_creator_01',
    });
  });

  it('returns nulls for a file the manifest does not mention', async () => {
    const path = await write('partial.json', JSON.stringify([{ file: 'video_01.mp4' }]));
    const manifest = await loadManifest(path);
    expect(manifest.get('video_99.mp4')).toEqual({ creatorId: null, creatorHandle: null });
  });

  it('allows an entry with no creator fields at all', async () => {
    const path = await write('bare.json', JSON.stringify([{ file: 'video_01.mp4' }]));
    const manifest = await loadManifest(path);
    expect(manifest.get('video_01.mp4')).toEqual({ creatorId: null, creatorHandle: null });
  });

  it('accepts explicit nulls', async () => {
    const path = await write(
      'nulls.json',
      JSON.stringify([{ file: 'video_01.mp4', creatorId: null, creatorHandle: null }]),
    );
    const manifest = await loadManifest(path);
    expect(manifest.get('video_01.mp4')).toEqual({ creatorId: null, creatorHandle: null });
  });

  it('reports manifest entries that match no file present', async () => {
    const path = await write(
      'stale.json',
      JSON.stringify([{ file: 'video_01.mp4' }, { file: 'gone.mp4' }]),
    );
    const manifest = await loadManifest(path);
    expect(manifest.unmatched(['video_01.mp4', 'video_02.mp4'])).toEqual(['gone.mp4']);
  });

  it('accepts an empty manifest', async () => {
    const manifest = await loadManifest(await write('empty.json', '[]'));
    expect(manifest.present).toBe(true);
    expect(manifest.size).toBe(0);
  });
});

describe('loadManifest rejects malformed input', () => {
  it('names the JSON error when the file is not JSON', async () => {
    const path = await write('broken.json', '{ not json');
    await expect(loadManifest(path)).rejects.toThrow(ManifestError);
    await expect(loadManifest(path)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a top-level object instead of an array', async () => {
    const path = await write('object.json', JSON.stringify({ file: 'video_01.mp4' }));
    await expect(loadManifest(path)).rejects.toThrow(/does not match the expected shape/);
  });

  it('rejects an entry missing the file field', async () => {
    const path = await write('nofile.json', JSON.stringify([{ creatorId: 'creator_01' }]));
    await expect(loadManifest(path)).rejects.toThrow(/does not match the expected shape/);
  });

  it('rejects a non-string creatorId', async () => {
    const path = await write(
      'badtype.json',
      JSON.stringify([{ file: 'video_01.mp4', creatorId: 42 }]),
    );
    await expect(loadManifest(path)).rejects.toThrow(/does not match the expected shape/);
  });

  it('rejects the same file listed twice, which would be ambiguous', async () => {
    const path = await write(
      'dupes.json',
      JSON.stringify([
        { file: 'video_01.mp4', creatorId: 'a' },
        { file: 'video_01.mp4', creatorId: 'b' },
      ]),
    );
    await expect(loadManifest(path)).rejects.toThrow(/more than once/);
  });

  it('shows the expected shape in the error, so the fix is obvious', async () => {
    const path = await write('object2.json', '{}');
    await expect(loadManifest(path)).rejects.toThrow(/"creatorHandle": "demo_creator_01"/);
  });
});
