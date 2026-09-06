import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDb, db } from '../../src/db/client.ts';
import { events, videoEmbeddings, videos } from '../../src/db/schema.ts';
import { getUserProfile } from '../../src/reco/profile.ts';
import { DEMO_USERS } from '../../scripts/seed-users.ts';
import { runSimulation } from '../../scripts/simulate-events.ts';

/**
 * The demo scenario has to be reproducible, because a live demonstration that drifts
 * a little on every run is worse than no demonstration at all.
 *
 * The failure this guards against is the one that actually happened during M7: each
 * run appended interactions instead of replacing them, the seen-filter grew, and
 * after enough runs a user had seen the whole corpus and every feed collapsed to a
 * couple of items. `--reset` is what makes the scenario a *state* rather than an
 * accumulation, and this test is what keeps it that way.
 */

const enabled = process.env.TEST_INTEGRATION === '1';

let hasCorpus = false;
if (enabled) {
  const [row] = await db
    .select({ id: videos.id })
    .from(videos)
    .innerJoin(videoEmbeddings, eq(videoEmbeddings.videoId, videos.id))
    .where(eq(videos.status, 'analyzed'))
    .limit(1);
  hasCorpus = Boolean(row);
}

afterAll(async () => {
  if (!enabled) return;
  await closeDb();
}, 60_000);

describe.skipIf(!enabled || !hasCorpus)('demo reset', () => {
  it('is idempotent: two resets leave identical events and identical profiles', async () => {
    const userIds = DEMO_USERS.map((user) => user.id);

    await runSimulation({ reset: true, quiet: true });
    const firstEvents = await db.select().from(events).where(inArray(events.userId, userIds));
    const firstProfiles = await Promise.all(userIds.map((id) => getUserProfile(id)));

    await runSimulation({ reset: true, quiet: true });
    const secondEvents = await db.select().from(events).where(inArray(events.userId, userIds));
    const secondProfiles = await Promise.all(userIds.map((id) => getUserProfile(id)));

    // Same number of events, not merely "some events": an append-instead-of-replace
    // regression shows up here as a doubling and nowhere else until the demo looks wrong.
    expect(secondEvents).toHaveLength(firstEvents.length);
    expect(new Set(secondEvents.map((e) => e.eventId))).toEqual(
      new Set(firstEvents.map((e) => e.eventId)),
    );

    for (let i = 0; i < userIds.length; i++) {
      const before = firstProfiles[i];
      const after = secondProfiles[i];
      expect(after).not.toBeNull();
      expect(after!.isColdStart).toBe(before!.isColdStart);
      expect(after!.effectiveSignalCount).toBe(before!.effectiveSignalCount);
      // The vectors are recomputed from scratch both times, so they must agree
      // exactly - the profile is a pure function of the event log.
      expect(after!.vector).toEqual(before!.vector);
    }
  }, 120_000);

  it('leaves exactly one cold-start user, which is what the demo needs', async () => {
    await runSimulation({ reset: true, quiet: true });

    const profiles = await Promise.all(DEMO_USERS.map((user) => getUserProfile(user.id)));
    const cold = profiles.filter((profile) => profile?.isColdStart);

    expect(cold).toHaveLength(1);
  }, 120_000);
});
