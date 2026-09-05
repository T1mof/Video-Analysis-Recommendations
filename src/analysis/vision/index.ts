import { env } from '../../config/env.ts';
import { MockVisionProvider } from './mock.ts';
import { OpenAICompatibleProvider } from './openaiCompatible.ts';
import type { VisionProvider } from './provider.ts';

export * from './provider.ts';
export { MockVisionProvider } from './mock.ts';
export { OpenAICompatibleProvider, extractJson } from './openaiCompatible.ts';

/**
 * Selects the provider from configuration. Switching between the mock and a real
 * model - or between two real models - is `VISION_PROVIDER` plus `VISION_MODEL`,
 * never a code change.
 */
export function createVisionProvider(
  kind: typeof env.VISION_PROVIDER = env.VISION_PROVIDER,
): VisionProvider {
  switch (kind) {
    case 'mock':
      return new MockVisionProvider();
    case 'openai-compatible':
      return new OpenAICompatibleProvider();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown vision provider: ${String(exhaustive)}`);
    }
  }
}
