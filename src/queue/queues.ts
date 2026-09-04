import { Queue } from 'bullmq';
import { sharedConnection } from './connection.ts';

export const QUEUE_ANALYSIS = 'analysis';

export interface AnalysisJob {
  videoId: string;
}

let analysis: Queue<AnalysisJob> | undefined;

/**
 * Analysis queue. Ingestion enqueues here; the worker that drains it arrives with
 * the analysis milestone. Jobs simply wait until then - which is the intended
 * behaviour, not a gap: ingestion and analysis are decoupled on purpose so a slow
 * or unavailable VLM never blocks getting content into the system.
 */
export function analysisQueue(): Queue<AnalysisJob> {
  analysis ??= new Queue<AnalysisJob>(QUEUE_ANALYSIS, {
    connection: sharedConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return analysis;
}

export async function closeQueues(): Promise<void> {
  if (analysis) {
    await analysis.close();
    analysis = undefined;
  }
}
