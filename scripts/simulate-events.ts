import { asc, eq, inArray } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { events, videoEmbeddings, videos } from '../src/db/schema.ts';
import { explainProfile } from '../src/analysis/embedding.ts';
import { rebuildUserProfile } from '../src/reco/profile.ts';
import { recordInteraction } from '../src/reco/interactions.ts';
import { EVENT_WEIGHTS } from '../src/reco/signals.ts';
import { env } from '../src/config/env.ts';
import { DEMO_USERS, seedUsers } from './seed-users.ts';

/**
 * Deterministic M5 demonstration.
 *
 * Two users react to the *same* corpus in opposite ways and end up with
 * different, explainable profiles. Everything is fixed: the users, which videos
 * each one likes, and the event timestamps - so the output is reproducible and
 * safe to show live.
 *
 * The vectors are the real Qwen3-VL taxonomy vectors from the corpus. Gold labels
 * are never used here: they are an evaluation artefact, and feeding them into a
 * user profile would be inventing preferences from ground truth the product does
 * not have.
 */

const DAY = 86_400_000;

interface Scenario {
  userId: string;
  label: string;
  /**
   * Selected by creator, not by position. The demo corpus interleaves creators
   * (creator_01 owns video_01, _11, _21), so an index-based split would hand both
   * users the same creators in a mirror image and produce identical affinity
   * scores - arithmetically correct and completely uninformative.
   */
  likes: string[];
  completes: string[];
  skips: string[];
  dislikes: string[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    userId: DEMO_USERS[0].id,
    label: DEMO_USERS[0].label,
    likes: ['demo_creator_01'],
    completes: ['demo_creator_02'],
    skips: ['demo_creator_08'],
    dislikes: ['demo_creator_09'],
  },
  {
    // The mirror image: what alice likes, bob rejects.
    userId: DEMO_USERS[1].id,
    label: DEMO_USERS[1].label,
    likes: ['demo_creator_08'],
    completes: ['demo_creator_09'],
    skips: ['demo_creator_01'],
    dislikes: ['demo_creator_02'],
  },
  {
    // One meaningful signal, so she stays below the cold-start threshold.
    userId: DEMO_USERS[2].id,
    label: DEMO_USERS[2].label,
    likes: ['demo_creator_05'],
    completes: [],
    skips: [],
    dislikes: [],
  },
];

function bar(value: number, width = 24): string {
  const filled = Math.round(Math.min(1, Math.abs(value) * 4) * width);
  return (value >= 0 ? '+' : '-').repeat(Math.max(1, filled));
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');

  await seedUsers();

  const corpus = await db
    .select({ id: videos.id, externalId: videos.externalId, creator: videos.creatorHandle })
    .from(videos)
    .innerJoin(videoEmbeddings, eq(videoEmbeddings.videoId, videos.id))
    .where(eq(videos.status, 'analyzed'))
    .orderBy(asc(videos.externalId));

  if (corpus.length === 0) {
    console.error(
      'No analysed videos with embeddings. Run: npm run ingest && npm run analyze -- --all',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`corpus: ${corpus.length} analysed videos`);
  console.log(
    `weights: like ${EVENT_WEIGHTS.like}  complete ${EVENT_WEIGHTS.complete}  ` +
      `view ${EVENT_WEIGHTS.view}  skip ${EVENT_WEIGHTS.skip}  dislike ${EVENT_WEIGHTS.dislike}  ` +
      `impression ${EVENT_WEIGHTS.impression}`,
  );
  console.log(
    `half-life: ${env.PROFILE_HALFLIFE_DAYS} days   cold start below: ` +
      `${env.COLD_START_MIN_INTERACTIONS} effective signals\n`,
  );

  const userIds = DEMO_USERS.map((u) => u.id);
  if (reset) {
    await db.delete(events).where(inArray(events.userId, userIds));
    console.log('cleared previous demo events (--reset)\n');
  }

  const now = Date.now();

  const byCreator = new Map<string, typeof corpus>();
  for (const video of corpus) {
    if (!video.creator) continue;
    const list = byCreator.get(video.creator) ?? [];
    list.push(video);
    byCreator.set(video.creator, list);
  }
  const videosOf = (creators: readonly string[]): typeof corpus =>
    creators.flatMap((handle) => byCreator.get(handle) ?? []);

  for (const scenario of SCENARIOS) {
    // Every touched video gets an impression first - that is what a feed actually
    // does, and it demonstrates that impressions alone never build a profile.
    const touched = videosOf([
      ...scenario.likes,
      ...scenario.completes,
      ...scenario.skips,
      ...scenario.dislikes,
    ]);

    for (const video of touched) {
      await recordInteraction({
        eventId: `sim:${scenario.label}:impression:${video.id}`,
        userId: scenario.userId,
        videoId: video.id,
        type: 'impression',
        occurredAt: new Date(now - 2 * DAY),
      });
    }

    const emit = async (
      creators: readonly string[],
      type: 'like' | 'complete' | 'skip' | 'dislike',
      ageDays: number,
    ): Promise<void> => {
      for (const video of videosOf(creators)) {
        await recordInteraction({
          eventId: `sim:${scenario.label}:${type}:${video.id}`,
          userId: scenario.userId,
          videoId: video.id,
          type,
          watchRatio: type === 'complete' ? 1 : type === 'like' ? 0.85 : 0.08,
          occurredAt: new Date(now - ageDays * DAY),
        });
      }
    };

    await emit(scenario.likes, 'like', 0);
    // Backdated a full half-life: these count for exactly half of a fresh event,
    // which is the decay curve being visible rather than asserted.
    await emit(scenario.completes, 'complete', env.PROFILE_HALFLIFE_DAYS);
    await emit(scenario.skips, 'skip', 1);
    await emit(scenario.dislikes, 'dislike', 1);

    const profile = await rebuildUserProfile(scenario.userId);
    const explanation = explainProfile(profile.vector, 5);

    console.log('='.repeat(74));
    console.log(`${scenario.label}   ${scenario.userId}`);
    console.log(
      `  interactions ${profile.interactionCount}   effective ${profile.effectiveSignalCount}` +
        `   cold start: ${profile.isColdStart ? 'YES' : 'no'}`,
    );
    console.log(
      `  signal mass  +${profile.positiveSignal.toFixed(2)} / -${profile.negativeSignal.toFixed(2)}` +
        (profile.skippedNoFeatures
          ? `   (${profile.skippedNoFeatures} events skipped: no analysed features)`
          : ''),
    );

    console.log('\n  likes');
    for (const term of explanation.positive) {
      console.log(`    ${term.dimension.padEnd(34)} ${term.contribution.toFixed(3)} ${bar(term.contribution)}`);
    }
    console.log('  dislikes');
    for (const term of explanation.negative) {
      console.log(`    ${term.dimension.padEnd(34)} ${term.contribution.toFixed(3)} ${bar(term.contribution)}`);
    }

    console.log('  creator affinity');
    for (const creator of profile.creatorAffinity.slice(0, 5)) {
      console.log(
        `    ${(creator.creatorHandle ?? creator.creatorId).padEnd(34)} ` +
          `${creator.score.toFixed(3)}  (${creator.interactionCount} interactions)`,
      );
    }
    console.log();
  }

  console.log('='.repeat(74));
  console.log('Same corpus, opposite behaviour, different profiles - which is the point.');
  console.log('Inspect over HTTP:  npm run dev:api');
  console.log(`  GET /users/${DEMO_USERS[0].id}/profile`);
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
