import { closeDb } from '../src/db/client.ts';
import { env } from '../src/config/env.ts';
import { recommendCandidates } from '../src/reco/recommender.ts';
import { diversityTags } from '../src/reco/diversityTags.ts';
import { DEMO_USERS } from './seed-users.ts';

/**
 * M6 demonstration: the same corpus, three users, three different orderings.
 *
 * Alice and Bob were given opposite behaviour in the M5 simulation, so their top
 * recommendations should diverge. Carol is cold-start and should be served global
 * signals instead of a personalised order.
 *
 * Nothing here asserts specific video ids - the corpus can change. It shows the
 * properties: divergence, cold-start behaviour, and why each item ranked where it did.
 */

const LIMIT = 10;

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

/** The named terms that actually moved this score, largest magnitude first. */
function reasons(weighted: Record<string, number>, sign: 1 | -1, topN: number): string {
  return (
    Object.entries(weighted)
      .filter(([, value]) => (sign === 1 ? value > 0.001 : value < -0.001))
      .sort((a, b) => (sign === 1 ? b[1] - a[1] : a[1] - b[1]))
      .slice(0, topN)
      .map(([name, value]) => `${name} ${signed(value)}`)
      .join(', ') || '—'
  );
}

async function main(): Promise<void> {
  console.log(
    `weights: affinity ${env.RANK_W_AFFINITY}  quality ${env.RANK_W_QUALITY}  ` +
      `freshness ${env.RANK_W_FRESHNESS}  popularity ${env.RANK_W_POPULARITY}  ` +
      `fatigue ${env.RANK_W_FATIGUE}  exploration ${env.RANK_W_EXPLORATION}  ` +
      `creator ${env.RANK_W_CREATOR_AFFINITY}`,
  );
  console.log(
    `diversity: lambda ${env.DIVERSITY_LAMBDA}  max same creator ${env.DIVERSITY_MAX_SAME_CREATOR}` +
      `  max same tag in top 10 ${env.DIVERSITY_MAX_SAME_TAG_IN_TOP10}\n`,
  );

  const topByUser = new Map<string, string[]>();

  for (const user of DEMO_USERS) {
    const result = await recommendCandidates(user.id, LIMIT);
    const d = result.diagnostics;

    console.log('='.repeat(110));
    console.log(
      `${user.label}   cold start: ${d.coldStart ? 'YES' : 'no'}   ` +
        `returned ${d.returned}/${d.requestedLimit}   ${d.latencyMs} ms`,
    );
    console.log(
      `  candidates: similar ${d.candidateCounts.similar}  tag ${d.candidateCounts.tag}  ` +
        `trending ${d.candidateCounts.trending}  fresh ${d.candidateCounts.fresh}  ` +
        `explore ${d.candidateCounts.explore}  → ${d.uniqueCandidates} unique`,
    );
    console.log(
      `  eligible ${d.eligibleVideos}   filtered as seen ${d.filteredSeen}` +
        (d.candidateShortage ? '   [candidate shortage]' : '') +
        (d.diversityRelaxed ? `   [diversity relaxed for ${d.relaxedCount}]` : ''),
    );
    console.log();
    console.log(
      `  ${pad('#', 3)}${pad('video', 10)}${pad('creator', 18)}${pad('sources', 26)}` +
        `${pad('base', 8)}${pad('final', 8)}${pad('penalty', 8)}`,
    );

    for (const [index, item] of result.items.entries()) {
      const video = result.videos.get(item.videoId)!;
      console.log(
        `  ${pad(String(index + 1), 3)}${pad(video.externalId ?? item.videoId.slice(0, 8), 10)}` +
          `${pad(video.creatorHandle ?? '(none)', 18)}${pad(item.sources.join(','), 26)}` +
          `${pad(item.baseScore.toFixed(3), 8)}${pad(item.finalScore.toFixed(3), 8)}` +
          `${pad(item.diversityPenalty.toFixed(3), 8)}`,
      );
      console.log(`        + ${reasons(item.weighted, 1, 3)}`);
      console.log(`        - ${reasons(item.weighted, -1, 2)}`);
      if (index === 0) {
        console.log(`        tags: ${diversityTags(video.features).slice(0, 5).join(', ')}`);
      }
    }

    topByUser.set(
      user.label,
      result.items.map((item) => result.videos.get(item.videoId)?.externalId ?? item.videoId),
    );
    console.log();
  }

  // The property that matters: opposite behaviour produced different orderings.
  const alice = topByUser.get('demo_alice') ?? [];
  const bob = topByUser.get('demo_bob') ?? [];
  const shared = alice.filter((id) => bob.includes(id)).length;
  const identical = alice.length === bob.length && alice.every((id, i) => id === bob[i]);

  console.log('='.repeat(110));
  console.log(
    `alice ∩ bob: ${shared}/${alice.length} videos in common, ` +
      `ordering ${identical ? 'IDENTICAL - personalization is not working' : 'different'}`,
  );
  console.log(`alice top 3: ${alice.slice(0, 3).join(', ')}`);
  console.log(`bob   top 3: ${bob.slice(0, 3).join(', ')}`);
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
