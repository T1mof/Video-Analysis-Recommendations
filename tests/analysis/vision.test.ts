import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockVisionProvider } from '../../src/analysis/vision/mock.ts';
import {
  OpenAICompatibleProvider,
  extractJson,
} from '../../src/analysis/vision/openaiCompatible.ts';
import { createVisionProvider, VisionError } from '../../src/analysis/vision/index.ts';
import { videoFeaturesSchema } from '../../src/analysis/schema.ts';
import { cosine, encodeFeatures } from '../../src/analysis/embedding.ts';
import { makeFeatures } from '../fixtures.ts';
import type { SampledFrame } from '../../src/analysis/preprocess.ts';

/**
 * Real files on disk rather than a mocked fs: the provider's job includes reading
 * and base64-encoding frames, and mocking that away would test less than it looks.
 */
let frameDir: string;
let frames: SampledFrame[] = [];

beforeAll(async () => {
  frameDir = await mkdtemp(join(tmpdir(), 'vision-frames-'));
  const paths = [join(frameDir, 'frame_001.jpg'), join(frameDir, 'frame_002.jpg')];
  for (const path of paths) await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  frames = [
    { timestampSec: 1, path: paths[0]!, hash: '0000000000000000' },
    { timestampSec: 5, path: paths[1]!, hash: 'ffffffffffffffff' },
  ];
});

afterAll(async () => {
  await rm(frameDir, { recursive: true, force: true });
});

const input = (videoId: string) => ({ videoId, durationSeconds: 30, frames });

describe('MockVisionProvider', () => {
  const provider = new MockVisionProvider();

  it('returns schema-valid features', async () => {
    const result = await provider.analyze(input('video-1'));
    expect(videoFeaturesSchema.safeParse(result.features).success).toBe(true);
  });

  it('is deterministic for the same video id', async () => {
    const a = await provider.analyze(input('video-1'));
    const b = await provider.analyze(input('video-1'));
    expect(b.features).toEqual(a.features);
  });

  it('gives different videos different features', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const result = await provider.analyze(input(`video-${i}`));
      seen.add(JSON.stringify(result.features));
    }
    // Not a hard uniqueness guarantee, but a corpus that collapses to one or two
    // distinct feature sets would make the recommender demo meaningless.
    expect(seen.size).toBeGreaterThan(10);
  });

  it('produces cluster structure, not uniform noise', async () => {
    // Videos are assigned to archetypes; within-archetype pairs must be more
    // similar than across-archetype pairs, or vector search has nothing to find.
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => provider.analyze(input(`video-${i}`))),
    );
    const items = results.map((r) => ({
      archetype: (r.raw as { archetype: string }).archetype,
      vector: encodeFeatures(r.features),
    }));

    let within = 0;
    let withinCount = 0;
    let across = 0;
    let acrossCount = 0;

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const similarity = cosine(items[i]!.vector, items[j]!.vector);
        if (items[i]!.archetype === items[j]!.archetype) {
          within += similarity;
          withinCount++;
        } else {
          across += similarity;
          acrossCount++;
        }
      }
    }

    expect(within / withinCount).toBeGreaterThan(across / acrossCount);
  });

  it('reports no token usage, so the cost model is never fed invented numbers', async () => {
    const result = await provider.analyze(input('video-1'));
    expect(result.usage).toEqual({ tokensIn: null, tokensOut: null });
  });

  it('identifies itself so rows stay attributable', async () => {
    const result = await provider.analyze(input('video-1'));
    expect(result.modelName).toBe('mock');
    expect(result.modelVersion).toBe('synthetic-archetype-v1');
    expect(result.attempts).toBe(1);
  });

  it('declares itself synthetic and says so in the caption', async () => {
    // Synthetic tags that look like analysis are worse than no tags: they invite
    // conclusions about a corpus nothing ever looked at.
    expect(provider.synthetic).toBe(true);
    const result = await provider.analyze(input('video-1'));
    expect(result.features.caption).toContain('SYNTHETIC');
    expect(result.modelVersion).toContain('synthetic');
    expect((result.raw as { synthetic: boolean }).synthetic).toBe(true);
  });

  it('never reads the gold labels', async () => {
    // Seeding the mock from reviewed ground truth would make the benchmark
    // measure itself. The archetype comes from a hash of the id and nothing else.
    const a = await provider.analyze(input('some-id'));
    const b = await provider.analyze({ ...input('some-id'), durationSeconds: 999 });
    expect(b.features.hairColor).toBe(a.features.hairColor);
    expect(b.features.setting).toBe(a.features.setting);
  });
});

describe('extractJson', () => {
  it('returns plain JSON unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a markdown fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('salvages an object surrounded by prose', () => {
    // Small local models routinely add commentary despite instructions.
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it('leaves text with no object alone', () => {
    expect(extractJson('no json here')).toBe('no json here');
  });
});

describe('createVisionProvider', () => {
  it('builds the mock provider', () => {
    expect(createVisionProvider('mock').name).toBe('mock');
  });

  it('builds the openai-compatible provider', () => {
    expect(createVisionProvider('openai-compatible').name).toBe('openai-compatible');
  });
});

describe('OpenAICompatibleProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(...responses: string[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn();
    for (const content of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 1200, completion_tokens: 180 },
        }),
      });
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function frameInput() {
    return { videoId: 'v1', durationSeconds: 30, frames };
  }

  it('rejects an empty frame set rather than calling the model', async () => {
    const provider = new OpenAICompatibleProvider();
    await expect(
      provider.analyze({ videoId: 'v1', durationSeconds: 30, frames: [] }),
    ).rejects.toThrow(VisionError);
  });

  it('parses a valid response and reports token usage', async () => {
    stubFetch(JSON.stringify(makeFeatures()));
    const provider = new OpenAICompatibleProvider({ maxRetries: 0 });
    const result = await provider.analyze(frameInput());

    expect(result.features.hairColor).toBe('blonde');
    expect(result.usage).toEqual({ tokensIn: 1200, tokensOut: 180 });
    expect(result.attempts).toBe(1);
  });

  it('retries once with the validation error fed back, then succeeds', async () => {
    const invalid = JSON.stringify(makeFeatures({ hairColor: 'brunette' as never }));
    const fetchMock = stubFetch(invalid, JSON.stringify(makeFeatures()));

    const provider = new OpenAICompatibleProvider({ maxRetries: 1 });
    const result = await provider.analyze(frameInput());

    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The repair prompt must name the offending field, or the retry is a coin flip.
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    const retryText = secondBody.messages[0]!.content[0]!.text ?? '';
    expect(retryText).toContain('previous response was rejected');
    expect(retryText).toContain('hairColor');
  });

  it('gives up with a clear error after exhausting retries', async () => {
    const invalid = JSON.stringify(makeFeatures({ explicitness: 'hardcore' as never }));
    stubFetch(invalid, invalid);

    const provider = new OpenAICompatibleProvider({ maxRetries: 1 });
    await expect(provider.analyze(frameInput())).rejects.toThrow(/did not return valid taxonomy/);
  });

  it('treats a non-JSON reply as a retryable failure', async () => {
    stubFetch('I cannot help with that.', JSON.stringify(makeFeatures()));

    const provider = new OpenAICompatibleProvider({ maxRetries: 1 });
    const result = await provider.analyze(frameInput());
    expect(result.attempts).toBe(2);
  });

  it('surfaces an HTTP error from the vision server', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'model loading',
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({ maxRetries: 0 });
    await expect(provider.analyze(frameInput())).rejects.toThrow(/HTTP 503/);
  });
});
