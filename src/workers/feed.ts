import { env } from '../config/env.ts';
import { closeDb } from '../db/client.ts';
import { closeRedis } from '../queue/connection.ts';
import { closeFeedQueue } from '../feed/queue.ts';
import { startFeedWorker } from '../feed/worker.ts';

/**
 * Feed build worker - its own runtime entrypoint.
 *
 * Not started inside the API process, and not merged into the analysis worker.
 * Feed builds and GPU analysis scale on completely different signals: one follows
 * user traffic, the other follows ingestion. Running them as separate processes is
 * what lets a deployment add feed workers during a traffic spike without also
 * paying for idle GPU capacity, and it is why the API can stay a Redis reader.
 */
async function main(): Promise<void> {
  const worker = startFeedWorker();

  console.log(
    `Feed worker started. concurrency=${env.FEED_CONCURRENCY}, feed size=${env.FEED_SIZE}, ` +
      `ttl=${env.FEED_TTL_SECONDS}s`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, finishing in-flight builds...`);
    // close() drains rather than kills: a half-built feed is never published, and
    // an interrupted job returns to the queue instead of being lost.
    await worker.close();
    await closeFeedQueue();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await closeFeedQueue();
  await closeRedis();
  await closeDb();
  process.exit(1);
});
