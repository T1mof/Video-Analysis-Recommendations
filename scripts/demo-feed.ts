import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.ts';
import { closeDb } from '../src/db/client.ts';
import { cacheConnection, closeRedis } from '../src/queue/connection.ts';
import {
  MAX_RETAINED_GENERATIONS_PER_USER,
  clearFeed,
  currentEpoch,
  retainedGenerations,
} from '../src/feed/cache.ts';
import { closeFeedQueue, feedQueue } from '../src/feed/queue.ts';
import { buildFeed } from '../src/feed/worker.ts';
import { DEMO_USERS } from './seed-users.ts';
import { runSimulation } from './simulate-events.ts';

/**
 * M7 demonstration: the full feed lifecycle over the real HTTP surface.
 *
 * The worker is driven inline here rather than by running a separate process, so
 * the script is self-contained - but it calls exactly the same `buildFeed` the
 * background worker calls. The API never builds anything itself; every 202 below
 * is the request path refusing to compute a feed.
 */

const LIMIT = 4;

function line(label: string, detail: string): void {
  console.log(`  ${label.padEnd(22)} ${detail}`);
}

/** Drains whatever the API queued, the way the feed worker would. */
async function runQueuedBuilds(): Promise<number> {
  const jobs = await feedQueue().getJobs(['waiting', 'delayed', 'prioritized']);
  let built = 0;
  for (const job of jobs) {
    const outcome = await buildFeed(job.data);
    await job.remove();
    if (outcome.published) built++;
  }
  return built;
}

async function get(app: FastifyInstance, url: string) {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function main(): Promise<void> {
  const app = buildServer({ logger: false });
  await app.ready();

  const alice = DEMO_USERS[0];
  const carol = DEMO_USERS[2];

  // Re-establish the M5 scenario rather than inheriting whatever the last run left
  // behind. Without this the demo degrades every time it is run: each pass records
  // more interactions, the seen filter grows, and eventually a user has seen the
  // whole corpus and every feed collapses to a couple of items. A demo that gets
  // worse each time you run it is not one to open a presentation with.
  await runSimulation({ reset: true, quiet: true });

  for (const user of DEMO_USERS) await clearFeed(user.id);
  for (const job of await feedQueue().getJobs(['waiting', 'delayed', 'prioritized'])) {
    await job.remove();
  }

  console.log('='.repeat(78));
  console.log('A. COLD CACHE - the API must not build the feed itself');
  const cold = await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
  line('status', String(cold.status));
  line('body', JSON.stringify(cold.body));

  const built = await runQueuedBuilds();
  line('worker built', `${built} generation(s)`);

  console.log('\n' + '='.repeat(78));
  console.log('B. CACHE HIT');
  const first = await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
  const firstFeedId = first.body.feedId as string;
  const firstItems = first.body.items as { videoId: string; rank: number }[];
  line('status', String(first.status));
  line('feedId', firstFeedId);
  line('coldStart', String(first.body.coldStart));
  line('items', firstItems.map((i) => `#${i.rank}`).join(' '));
  line('nextCursor', `${String(first.body.nextCursor).slice(0, 28)}...`);

  console.log('\n' + '='.repeat(78));
  console.log('C. PAGINATION - same generation, next slice, no repeats');
  const second = await get(
    app,
    `/feed?userId=${alice.id}&limit=${LIMIT}&cursor=${encodeURIComponent(String(first.body.nextCursor))}`,
  );
  const secondItems = second.body.items as { videoId: string; rank: number }[];
  line('status', String(second.status));
  line('feedId', `${String(second.body.feedId)}  (same: ${String(second.body.feedId === firstFeedId)})`);
  line('items', secondItems.map((i) => `#${i.rank}`).join(' '));
  const overlap = firstItems.filter((a) => secondItems.some((b) => b.videoId === a.videoId));
  line('overlap', `${overlap.length} duplicate item(s)`);

  console.log('\n' + '='.repeat(78));
  console.log('D. REPEATED HITS QUEUE NO BUILDS');
  for (let i = 0; i < 5; i++) await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
  const queuedAfterHits = await feedQueue().getJobs(['waiting', 'delayed', 'prioritized']);
  line('5 more GETs', `${queuedAfterHits.length} build job(s) queued`);

  console.log('\n' + '='.repeat(78));
  console.log('E. INTERACTION INVALIDATES; DUPLICATE DOES NOT');
  const epochBefore = await currentEpoch(alice.id);
  const videoId = firstItems[0]!.videoId;
  const payload = {
    eventId: `demo-feed-${Date.now()}`,
    userId: alice.id,
    videoId,
    type: 'like' as const,
  };

  const accepted = await app.inject({ method: 'POST', url: '/interactions', payload });
  const epochAfter = await currentEpoch(alice.id);
  line('POST interaction', `${accepted.statusCode}  ${JSON.stringify(accepted.json())}`);
  line('epoch', `${epochBefore} -> ${epochAfter}`);

  const duplicate = await app.inject({ method: 'POST', url: '/interactions', payload });
  const epochAfterDuplicate = await currentEpoch(alice.id);
  line('duplicate', `${duplicate.statusCode}  epoch still ${epochAfterDuplicate}`);

  const stale = await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
  line('feed after invalidation', `${stale.status}  ${JSON.stringify(stale.body)}`);

  console.log('\n' + '='.repeat(78));
  console.log('F. REBUILT FEED - new generation, old cursor still readable');
  await runQueuedBuilds();
  const rebuilt = await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
  line('status', String(rebuilt.status));
  line('feedId', `${String(rebuilt.body.feedId)}  (changed: ${String(rebuilt.body.feedId !== firstFeedId)})`);

  const oldCursor = await get(
    app,
    `/feed?userId=${alice.id}&limit=${LIMIT}&cursor=${encodeURIComponent(String(first.body.nextCursor))}`,
  );
  line('old cursor', `${oldCursor.status}  reads feedId ${String(oldCursor.body.feedId)}`);

  console.log('\n' + '='.repeat(78));
  console.log('G. COLD-START USER');
  await get(app, `/feed?userId=${carol.id}&limit=${LIMIT}`);
  await runQueuedBuilds();
  const carolFeed = await get(app, `/feed?userId=${carol.id}&limit=${LIMIT}`);
  line('status', String(carolFeed.status));
  line('coldStart', String(carolFeed.body.coldStart));
  line('items', (carolFeed.body.items as { rank: number }[]).map((i) => `#${i.rank}`).join(' '));

  console.log('\n' + '='.repeat(78));
  console.log('H. IMPRESSIONS DO NOT FORCE A REBUILD');
  const activeBefore = (await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`)).body
    .feedId as string;
  const epochBeforeImpressions = await currentEpoch(alice.id);

  for (let i = 0; i < 10; i++) {
    await app.inject({
      method: 'POST',
      url: '/interactions',
      payload: {
        eventId: `demo-imp-${Date.now()}-${i}`,
        userId: alice.id,
        videoId: firstItems[i % firstItems.length]!.videoId,
        type: 'impression' as const,
      },
    });
  }

  const afterImpressions = await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
  line('10 impressions', `epoch ${epochBeforeImpressions} -> ${await currentEpoch(alice.id)}`);
  line('queued builds', String((await feedQueue().getJobs(['waiting', 'delayed'])).length));
  line(
    'session',
    `${afterImpressions.status}  same feedId: ${String(afterImpressions.body.feedId === activeBefore)}`,
  );

  console.log('\n' + '='.repeat(78));
  console.log('I. GENERATION RETENTION - rapid rebuilds stay bounded');
  for (let i = 0; i < 8; i++) {
    await buildFeed({ userId: alice.id, epoch: await currentEpoch(alice.id), reason: 'prewarm' });
  }
  const retained = await retainedGenerations(alice.id);
  const livePayloads = await cacheConnection().keys(`feed:gen:${alice.id}:*`);
  line('8 rebuilds', `${retained.length} retained (limit ${MAX_RETAINED_GENERATIONS_PER_USER})`);
  line('live payloads', `${livePayloads.length}`);
  line('active resolves', String((await get(app, `/feed?userId=${alice.id}&limit=1`)).status === 200));

  console.log('\n' + '='.repeat(78));
  console.log('J. LATENCY');
  const hits: number[] = [];
  for (let i = 0; i < 50; i++) {
    const started = process.hrtime.bigint();
    await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
    hits.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  hits.sort((a, b) => a - b);
  line('cache hit (50 reqs)', `mean ${mean(hits).toFixed(2)} ms  p50 ${hits[24]!.toFixed(2)} ms  p95 ${hits[47]!.toFixed(2)} ms`);

  await clearFeed(alice.id);
  const missStarted = process.hrtime.bigint();
  await get(app, `/feed?userId=${alice.id}&limit=${LIMIT}`);
  const missMs = Number(process.hrtime.bigint() - missStarted) / 1e6;
  line('cold miss (enqueue)', `${missMs.toFixed(2)} ms`);

  const buildStarted = process.hrtime.bigint();
  await runQueuedBuilds();
  line('background build', `${(Number(process.hrtime.bigint() - buildStarted) / 1e6).toFixed(0)} ms`);

  const generation = await get(app, `/feed?userId=${alice.id}&limit=50`);
  const bytes = Buffer.byteLength(JSON.stringify(generation.body), 'utf8');
  line('payload size', `${bytes} bytes for ${(generation.body.items as unknown[]).length} items`);

  await app.close();
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

main()
  .then(async () => {
    await closeFeedQueue();
    await closeRedis();
    await closeDb();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await closeFeedQueue();
    await closeRedis();
    await closeDb();
    process.exit(1);
  });
