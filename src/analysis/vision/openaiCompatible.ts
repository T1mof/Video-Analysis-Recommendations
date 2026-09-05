import { readFile } from 'node:fs/promises';
import { env } from '../../config/env.ts';
import {
  PROMPT_VERSION,
  buildPrompt,
  jsonSchemaForFeatures,
  videoFeaturesSchema,
} from '../schema.ts';
import {
  VisionError,
  type VideoAnalysisInput,
  type VisionAnalysis,
  type VisionErrorKind,
  type VisionProvider,
} from './provider.ts';

/**
 * Adapter for any server speaking the OpenAI chat-completions shape with image
 * content parts: Ollama, llama.cpp, vLLM, LM Studio, or a hosted endpoint.
 *
 * One adapter covers every candidate model, so choosing between them is an .env
 * change rather than a code change - which is what makes the benchmark in
 * scripts/bench-vlm.ts a real comparison instead of a rewrite.
 *
 * Note this is one *implementation* of VisionProvider, not the contract. Nothing
 * in the interface assumes HTTP or OpenAI's message format; a local ONNX runtime
 * or a gRPC service would sit alongside this file, not replace the abstraction.
 */

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAICompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  modelVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Ask the server to constrain decoding to the JSON schema, when supported. */
  useStructuredOutput?: boolean;
}

export class OpenAICompatibleProvider implements VisionProvider {
  readonly name = 'openai-compatible';
  readonly modelName: string;
  readonly modelVersion: string;
  readonly synthetic = false;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  /**
   * Whether to ask for schema-constrained decoding. Flipped to false at runtime
   * the first time a server rejects it, so one probe covers the whole run instead
   * of every video paying for the same rejection.
   */
  private useStructuredOutput: boolean;
  /** Set once the server proves it accepts (or refuses) json_schema. */
  private structuredOutputProbed = false;

  constructor(options: OpenAICompatibleOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env.VISION_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? env.VISION_API_KEY;
    this.modelName = options.model ?? env.VISION_MODEL;
    this.modelVersion = options.modelVersion ?? env.VISION_MODEL_VERSION;
    this.timeoutMs = options.timeoutMs ?? env.VISION_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? env.VISION_MAX_RETRIES;
    this.useStructuredOutput = options.useStructuredOutput ?? true;
  }

  /** True once the server has demonstrated it honours json_schema. */
  get structuredOutputActive(): boolean {
    return this.useStructuredOutput;
  }

  async analyze(input: VideoAnalysisInput): Promise<VisionAnalysis> {
    const startedAt = Date.now();

    if (input.frames.length === 0) {
      throw new VisionError(
        `No frames to analyze for video ${input.videoId}`,
        'no_frames',
        0,
      );
    }

    const images = await Promise.all(
      input.frames.map(async (frame) => {
        const bytes = await readFile(frame.path);
        return `data:image/jpeg;base64,${bytes.toString('base64')}`;
      }),
    );

    const prompt = buildPrompt(input.frames.length, input.durationSeconds);

    let lastError: string | null = null;
    let lastErrorKind: VisionErrorKind = 'model_error';

    // One extra attempt per retry, feeding the validation errors back. A model
    // that returned "platinum_blonde" usually corrects itself when told the exact
    // problem, and one repair call is far cheaper than discarding the video.
    // Bounded on purpose: an endless repair loop on a model that cannot follow the
    // schema burns GPU time and hides the real problem.
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      const content = this.buildContent(prompt, images, lastError);
      const response = await this.callWithFallback(content);

      const usage = {
        tokensIn: response.usage?.prompt_tokens ?? null,
        tokensOut: response.usage?.completion_tokens ?? null,
      };

      const text = response.choices?.[0]?.message?.content ?? '';

      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(text));
      } catch (error) {
        lastError = `Response was not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`;
        lastErrorKind = 'invalid_json';
        continue;
      }

      const result = videoFeaturesSchema.safeParse(parsed);
      if (result.success) {
        return {
          features: result.data,
          raw: parsed,
          modelName: this.modelName,
          modelVersion: this.modelVersion,
          promptVersion: PROMPT_VERSION,
          usage,
          latencyMs: Date.now() - startedAt,
          attempts: attempt,
        };
      }

      lastError = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      lastErrorKind = 'schema_validation';
    }

    throw new VisionError(
      `Model ${this.modelName} did not return valid taxonomy output after ` +
        `${this.maxRetries + 1} attempt(s). Last error: ${lastError}`,
      lastErrorKind,
      this.maxRetries + 1,
    );
  }

  private buildContent(
    prompt: string,
    images: readonly string[],
    previousError: string | null,
  ): unknown[] {
    const instruction = previousError
      ? `${prompt}\n\nYour previous response was rejected:\n${previousError}\n` +
        `Return corrected JSON using only the allowed values.`
      : prompt;

    return [
      { type: 'text', text: instruction },
      ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
  }

  /**
   * Sends one request, transparently falling back when the backend cannot do
   * schema-constrained decoding.
   *
   * Backends vary: vLLM and hosted OpenAI honour `json_schema`, some Ollama builds
   * accept only `json_object`, older llama.cpp servers reject `response_format`
   * outright. Rather than requiring the operator to know which, the first refusal
   * downgrades the whole run - constrained decoding is an optimisation, and the
   * Zod validation plus repair retry is the actual guarantee.
   */
  private async callWithFallback(content: unknown[]): Promise<ChatCompletionResponse> {
    try {
      return await this.call(content);
    } catch (error) {
      const rejectedSchema =
        error instanceof VisionError &&
        error.kind === 'model_error' &&
        this.useStructuredOutput &&
        !this.structuredOutputProbed;

      if (!rejectedSchema) throw error;

      this.useStructuredOutput = false;
      this.structuredOutputProbed = true;
      console.warn(
        `[vision] ${this.baseUrl} rejected json_schema response_format; ` +
          `falling back to prompt-enforced JSON for the rest of this run.`,
      );
      return this.call(content);
    }
  }

  private async call(content: unknown[]): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_tokens: 1500,
    };

    if (this.useStructuredOutput) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'video_features',
          strict: true,
          schema: jsonSchemaForFeatures(),
        },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // 4xx is the server refusing what we asked for (bad model name, unsupported
        // response_format); 5xx is the server failing to do it. Only the former is
        // worth downgrading structured output over.
        const kind: VisionErrorKind = response.status >= 400 && response.status < 500
          ? 'model_error'
          : 'transport';
        throw new VisionError(
          `Vision server returned HTTP ${response.status}: ${detail.slice(0, 500)}`,
          kind,
          1,
        );
      }

      return (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      if (error instanceof VisionError) throw error;

      if (controller.signal.aborted) {
        throw new VisionError(
          `Vision request to ${this.baseUrl} timed out after ${this.timeoutMs} ms`,
          'timeout',
          1,
          { cause: error },
        );
      }

      const reason = error instanceof Error ? error.message : String(error);
      throw new VisionError(
        `Vision request to ${this.baseUrl} failed: ${reason}`,
        'transport',
        1,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pulls the JSON object out of a response.
 *
 * Smaller local models routinely wrap output in prose or a markdown fence despite
 * being told not to. Salvaging the object costs nothing and avoids burning a retry
 * on a model that actually answered correctly.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}
