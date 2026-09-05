import { env } from '../config/env.ts';
import { closeDb } from '../db/client.ts';
import { closeRedis } from '../queue/connection.ts';
import { startAnalysisWorker } from './analysisWorker.ts';

/**
 * Background worker process.
 *
 * Separate from the API on purpose: the whole 3k RPS design rests on the HTTP path
 * doing nothing but a Redis read, which is only credible if the expensive work
 * lives in a process that scales independently. Locally that separation costs
 * nothing; in production it is what lets GPU workers and API pods scale on
 * different signals.
 */
async function main(): Promise<void> {
  const workers = [startAnalysisWorker()];

  console.log(
    `Workers started. analysis concurrency=${env.ANALYSIS_CONCURRENCY}, ` +
      `vision provider=${env.VISION_PROVIDER}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, finishing in-flight jobs...`);
    // close() waits for active jobs rather than killing them, so a video is never
    // left in status='analyzing' with nothing working on it.
    await Promise.all(workers.map((worker) => worker.close()));
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await closeRedis();
  await closeDb();
  process.exit(1);
});
