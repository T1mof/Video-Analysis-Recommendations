import { eq } from 'drizzle-orm';
import { TAXONOMY_VERSION } from './taxonomy.ts';
import type { VideoFeatures } from './schema.ts';
import { db } from '../db/client.ts';
import { videoEmbeddings, videoFeatures, videos } from '../db/schema.ts';
import { encodeFeatures } from './embedding.ts';
import { preprocessVideo } from './preprocess.ts';
import {
  createVisionProvider,
  VisionError,
  type VisionErrorKind,
  type VisionProvider,
} from './vision/index.ts';

/**
 * video -> frames -> model -> validated features -> Postgres.
 *
 * The frame lifecycle matters here: sampled frames exist only inside
 * preprocessVideo's `beforeCleanup` window, so the model call happens *inside*
 * that callback. Once analyze() returns, the temporary frames are deleted - they
 * are analysis artefacts, not stored media.
 */

export interface AnalyzeOptions {
  provider?: VisionProvider;
  /** Re-analyze a video that already has features. */
  force?: boolean;
  /**
   * Write results to the database. Set false to evaluate a model without
   * disturbing the corpus.
   *
   * Benchmarking a challenger model would otherwise overwrite the incumbent's
   * features and vectors - and since a benchmark may well conclude "keep the
   * incumbent", that would destroy the very data being defended. With persist
   * false the features are returned in the result and the caller decides what to
   * do with them.
   */
  persist?: boolean;
}

export interface AnalyzeResult {
  videoId: string;
  externalId: string | null;
  status: 'analyzed' | 'skipped' | 'failed';
  modelName?: string;
  modelVersion?: string;
  /** True when features were fabricated rather than derived from the video. */
  synthetic?: boolean;
  framesUsed?: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  visionLatencyMs?: number;
  totalMs?: number;
  attempts?: number;
  caption?: string;
  /** Returned when persist is false, so a caller can score without a DB write. */
  features?: VideoFeatures;
  error?: string;
  /** Classified failure cause, so a run's errors can be grouped. */
  errorKind?: VisionErrorKind | 'preprocess' | 'persistence';
}

export async function analyzeVideo(
  videoId: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const provider = options.provider ?? createVisionProvider();
  const persist = options.persist ?? true;

  const [video] = await db
    .select({ id: videos.id, externalId: videos.externalId, status: videos.status })
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1);

  if (!video) {
    return { videoId, externalId: null, status: 'failed', error: 'No such video' };
  }

  if (persist && !options.force) {
    const [existing] = await db
      .select({ videoId: videoFeatures.videoId })
      .from(videoFeatures)
      .where(eq(videoFeatures.videoId, videoId))
      .limit(1);
    if (existing) {
      return { videoId, externalId: video.externalId, status: 'skipped' };
    }
  }

  if (persist) {
    await db.update(videos).set({ status: 'analyzing' }).where(eq(videos.id, videoId));
  }

  try {
    let analysisLatency = 0;
    let framesUsed = 0;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let attempts = 0;
    let caption = '';
    let features: VideoFeatures | undefined;

    await preprocessVideo(videoId, {
      beforeCleanup: async (prepared) => {
        if (prepared.selectedFrames.length === 0) {
          throw new VisionError(
            `Preprocessing produced no frames for ${videoId}`,
            'no_frames',
            0,
          );
        }

        const analysis = await provider.analyze({
          videoId,
          durationSeconds: prepared.durationSec,
          frames: prepared.selectedFrames,
        });

        // Encoded even when not persisting: it exercises the same validation path
        // a real run would take, so an evaluation run cannot pass on features that
        // would fail to store.
        const embedding = encodeFeatures(analysis.features);

        if (!persist) {
          analysisLatency = analysis.latencyMs;
          framesUsed = prepared.selectedFrames.length;
          tokensIn = analysis.usage.tokensIn;
          tokensOut = analysis.usage.tokensOut;
          attempts = analysis.attempts;
          caption = analysis.features.caption;
          features = analysis.features;
          return;
        }

        // Features and embedding are written together: a features row without a
        // vector is invisible to candidate generation, which would look like a
        // ranking bug rather than a missing write.
        await db.transaction(async (tx) => {
          await tx
            .insert(videoFeatures)
            .values({
              videoId,
              modelName: analysis.modelName,
              modelVersion: analysis.modelVersion,
              promptVersion: analysis.promptVersion,
              taxonomyVersion: TAXONOMY_VERSION,
              features: analysis.features,
              raw: analysis.raw as Record<string, unknown>,
              framesUsed: prepared.selectedFrames.length,
              tokensIn: analysis.usage.tokensIn,
              tokensOut: analysis.usage.tokensOut,
              latencyMs: analysis.latencyMs,
            })
            .onConflictDoUpdate({
              target: videoFeatures.videoId,
              set: {
                modelName: analysis.modelName,
                modelVersion: analysis.modelVersion,
                promptVersion: analysis.promptVersion,
                taxonomyVersion: TAXONOMY_VERSION,
                features: analysis.features,
                raw: analysis.raw as Record<string, unknown>,
                framesUsed: prepared.selectedFrames.length,
                tokensIn: analysis.usage.tokensIn,
                tokensOut: analysis.usage.tokensOut,
                latencyMs: analysis.latencyMs,
                analyzedAt: new Date(),
              },
            });

          await tx
            .insert(videoEmbeddings)
            .values({ videoId, taxonomyVersion: TAXONOMY_VERSION, embedding })
            .onConflictDoUpdate({
              target: videoEmbeddings.videoId,
              set: { taxonomyVersion: TAXONOMY_VERSION, embedding },
            });
        });

        analysisLatency = analysis.latencyMs;
        framesUsed = prepared.selectedFrames.length;
        tokensIn = analysis.usage.tokensIn;
        tokensOut = analysis.usage.tokensOut;
        attempts = analysis.attempts;
        caption = analysis.features.caption;
        features = analysis.features;
      },
    });

    if (persist) {
      await db
        .update(videos)
        .set({ status: 'analyzed', failureReason: null })
        .where(eq(videos.id, videoId));
    }

    return {
      videoId,
      externalId: video.externalId,
      status: 'analyzed',
      modelName: provider.modelName,
      modelVersion: provider.modelVersion,
      synthetic: provider.synthetic,
      framesUsed,
      tokensIn,
      tokensOut,
      visionLatencyMs: analysisLatency,
      totalMs: Date.now() - startedAt,
      attempts,
      caption,
      features,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorKind: AnalyzeResult['errorKind'] =
      error instanceof VisionError ? error.kind : 'preprocess';

    // Recorded on the row rather than only logged, so a failed corpus can be
    // triaged with SQL instead of by re-reading worker output. The kind is
    // prefixed so `SELECT failure_reason` groups by cause. Skipped when not
    // persisting: an evaluation run must not mark corpus videos as failed.
    if (persist) {
      await db
        .update(videos)
        .set({
          status: 'failed',
          failureReason: `[${errorKind}] ${message}`.slice(0, 1000),
        })
        .where(eq(videos.id, videoId));
    }

    return {
      videoId,
      externalId: video.externalId,
      status: 'failed',
      totalMs: Date.now() - startedAt,
      error: message,
      errorKind,
    };
  }
}

/** Ids that still need analysis, in stable corpus order. */
export async function listAnalyzableVideoIds(includeAnalyzed = false): Promise<string[]> {
  const rows = await db
    .select({ id: videos.id, externalId: videos.externalId, status: videos.status })
    .from(videos)
    .orderBy(videos.externalId);

  return rows
    .filter((row) => includeAnalyzed || row.status !== 'analyzed')
    .map((row) => row.id);
}
