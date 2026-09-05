import { Worker, type Job } from 'bullmq';
import { env } from '../config/env.ts';
import { createRedisConnection } from '../queue/connection.ts';
import { QUEUE_ANALYSIS, type AnalysisJob } from '../queue/queues.ts';
import { analyzeVideo } from '../analysis/analyzeVideo.ts';
import { createVisionProvider } from '../analysis/vision/index.ts';

/**
 * Drains the analysis queue.
 *
 * Concurrency is configuration rather than a constant because it is bounded by
 * GPU memory, not by CPU: a 6 GB card running a quantised VLM fits one inference
 * at a time, while a rented A10 comfortably takes several. Getting this wrong
 * manifests as out-of-memory failures partway through a corpus run.
 *
 * A failed video does not fail the queue. `analyzeVideo` records the reason on the
 * row and returns; BullMQ retries transient problems, and a permanently bad video
 * ends up with status='failed' and a readable failure_reason instead of blocking
 * everything behind it.
 */
export function startAnalysisWorker(): Worker<AnalysisJob> {
  const provider = createVisionProvider();

  const worker = new Worker<AnalysisJob>(
    QUEUE_ANALYSIS,
    async (job: Job<AnalysisJob>) => {
      const result = await analyzeVideo(job.data.videoId, { provider });

      // Surfaced as a job failure so BullMQ's retry policy applies, but the row
      // already carries the diagnosis either way.
      if (result.status === 'failed') {
        throw new Error(result.error ?? 'Analysis failed');
      }
      return result;
    },
    {
      connection: createRedisConnection(),
      concurrency: env.ANALYSIS_CONCURRENCY,
    },
  );

  worker.on('completed', (job, result) => {
    const outcome = result as { externalId?: string | null; status?: string };
    console.log(
      `[analysis] ${outcome.externalId ?? job.data.videoId}: ${outcome.status ?? 'done'}`,
    );
  });

  worker.on('failed', (job, error) => {
    console.error(`[analysis] ${job?.data.videoId ?? 'unknown'} failed: ${error.message}`);
  });

  return worker;
}
