import { closeDb } from '../src/db/client.ts';
import { clearFeed } from '../src/feed/cache.ts';
import { closeFeedQueue, feedQueue } from '../src/feed/queue.ts';
import { closeRedis } from '../src/queue/connection.ts';
import { DEMO_USERS } from './seed-users.ts';
import { runSimulation } from './simulate-events.ts';

/**
 * Puts Alice, Bob and Carol back to the known starting state.
 *
 * Deliberately a thin wrapper over the M5 simulation rather than a second dataset
 * generator: there is one definition of what the demo scenario *is*, and it is
 * `scripts/simulate-events.ts`. Two generators would drift, and the version the
 * reviewer sees would depend on which command was run last.
 *
 * What this adds on top of the simulation is the M7 state the simulation knows
 * nothing about - cached generations and queued builds. Without clearing those, a
 * reset would leave feeds that were ranked against the *previous* run's profile:
 * fresh interactions, stale recommendations, and a demo that contradicts itself on
 * screen.
 *
 * Idempotent by construction. Run it as often as you like, including mid-demo.
 */
async function main(): Promise<void> {
  console.log('resetting demo state\n');

  // `reset: true` clears the demo users' events first, so the scenario is rebuilt
  // rather than accumulated. Without it, every run adds interactions until a user
  // has seen the whole corpus and every feed collapses to a handful of items.
  const established = await runSimulation({ reset: true });

  // Cached feeds and queued jobs are cleared either way. If the corpus is missing,
  // any feed left over from an earlier run is worse than none: it would be ranked
  // against videos this database can no longer explain.
  for (const user of DEMO_USERS) {
    await clearFeed(user.id);
  }
  console.log(`\ncleared cached feeds for ${DEMO_USERS.length} demo users`);

  // Queued builds carry an epoch from before the reset; the worker would discard
  // them anyway as stale, but leaving them makes the next demo's job counts
  // confusing for no benefit.
  const pending = await feedQueue().getJobs(['waiting', 'delayed', 'prioritized']);
  for (const job of pending) await job.remove().catch(() => {});
  console.log(`removed ${pending.length} pending feed build job(s)`);

  // Never report "ready" over the top of an error. A clone with no corpus is a
  // legitimate state - the API, /demo and the tests all run - but the demo scenario
  // does not exist, and saying otherwise is how that gets discovered on stage.
  if (!established) {
    console.log('\nNOT ready: the demo scenario needs an analysed corpus.');
    console.log('  The 18+ videos are not in this repository. Put 20-30 vertical .mp4');
    console.log('  files in data/seed/videos/ (or set DEMO_SOURCE_DIR), then:');
    console.log('    npm run ingest -- --mapping-out data/seed/mapping.json');
    console.log('    npm run preprocess -- --all');
    console.log('    npm run analyze -- --all --provider mock');
    console.log('    npm run demo:reset');
    console.log('\n  Without it the API, /demo and the test suite still run - every feed');
    console.log('  is simply empty. See README "Add a corpus".');
    return;
  }

  console.log('\nready. Next:');
  console.log('  npm run dev:api        # terminal 1');
  console.log('  npm run worker:feed    # terminal 2  <- without this every feed stays 202');
  console.log('  open http://localhost:3000/demo');
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
