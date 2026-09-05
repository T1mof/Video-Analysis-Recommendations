import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { closeDb } from '../db/client.ts';
import { explainProfile } from '../analysis/embedding.ts';
import { TAXONOMY_DIM, TAXONOMY_VERSION } from '../analysis/taxonomy.ts';
import {
  ACCEPTED_EVENT_TYPES,
  UnknownReferenceError,
  interactionSchema,
  recordInteraction,
} from '../reco/interactions.ts';
import { getUserProfile, rebuildUserProfile } from '../reco/profile.ts';
import { EVENT_WEIGHTS } from '../reco/signals.ts';

/**
 * HTTP surface.
 *
 * M5 only: interaction intake and a profile inspector. There is deliberately no
 * `/feed` here yet - that is M7, and it must be a Redis read rather than
 * anything that touches this code.
 *
 * The profile rebuild runs inline on write. With one user's history that is a
 * few milliseconds, and it keeps the demo honest: post a like, read the profile,
 * see it move. Production moves this to a queue - see ARCHITECTURE.md - which is
 * why the rebuild is a separate function call rather than inlined logic.
 */

export function buildServer(): FastifyInstance {
  // Request logs are useful in a demo and noise in a test run.
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  });

  app.get('/health', async () => ({
    status: 'ok',
    taxonomyVersion: TAXONOMY_VERSION,
    taxonomyDim: TAXONOMY_DIM,
  }));

  /**
   * Weights are part of the contract: a client can see how its events are valued.
   * `acceptedEventTypes` is narrower than `eventWeights` - `watch` is a legacy
   * value that still scores stored rows but is no longer accepted, so advertising
   * the weights alone would invite a 400.
   */
  app.get('/signals', async () => ({
    acceptedEventTypes: ACCEPTED_EVENT_TYPES,
    eventWeights: EVENT_WEIGHTS,
    halfLifeDays: env.PROFILE_HALFLIFE_DAYS,
    coldStartMinInteractions: env.COLD_START_MIN_INTERACTIONS,
  }));

  app.post('/interactions', async (request, reply) => {
    const parsed = interactionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_interaction',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    try {
      const result = await recordInteraction(parsed.data);
      // Rebuilt even when the event was a duplicate no-op: cheap, and it keeps
      // the response describing the current profile rather than a stale one.
      const profile = await rebuildUserProfile(parsed.data.userId);
      return reply.code(result.recorded ? 201 : 200).send({
        recorded: result.recorded,
        duplicate: !result.recorded,
        profile: {
          isColdStart: profile.isColdStart,
          effectiveSignalCount: profile.effectiveSignalCount,
          interactionCount: profile.interactionCount,
        },
      });
    } catch (error) {
      if (error instanceof UnknownReferenceError) {
        return reply.code(404).send({ error: 'unknown_reference', message: error.message });
      }
      throw error;
    }
  });

  const profileParams = z.object({ userId: z.string().uuid() });

  app.get('/users/:userId/profile', async (request, reply) => {
    const params = profileParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_user_id' });
    }

    const query = request.query as { vector?: string; top?: string };
    const topN = Math.min(20, Math.max(1, Number(query.top ?? 5) || 5));

    const profile = await getUserProfile(params.data.userId);
    if (!profile) {
      return reply.code(404).send({ error: 'no_profile', message: 'User has no profile yet' });
    }

    const explanation = explainProfile(profile.vector, topN);
    return reply.send({
      userId: profile.userId,
      taxonomyVersion: profile.taxonomyVersion,
      isColdStart: profile.isColdStart,
      interactionCount: profile.interactionCount,
      effectiveSignalCount: profile.effectiveSignalCount,
      positiveSignal: Number(profile.positiveSignal.toFixed(4)),
      negativeSignal: Number(profile.negativeSignal.toFixed(4)),
      skippedNoFeatures: profile.skippedNoFeatures,
      topPositivePreferences: explanation.positive,
      topNegativePreferences: explanation.negative,
      creatorAffinity: profile.creatorAffinity.slice(0, topN),
      // 110 numbers are noise in a terminal; opt in when you actually need them.
      ...(query.vector === 'true' ? { vector: profile.vector } : {}),
    });
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildServer();
  const close = async (): Promise<void> => {
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

// Only starts a listener when executed directly; importing it for tests must not
// bind a port.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
