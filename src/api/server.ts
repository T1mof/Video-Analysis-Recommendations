import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { env } from '../config/env.ts';
import { closeDb, db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { cacheConnection, closeRedis } from '../queue/connection.ts';
import { explainProfile } from '../analysis/embedding.ts';
import { TAXONOMY_DIM, TAXONOMY_VERSION } from '../analysis/taxonomy.ts';
import {
  ACCEPTED_EVENT_TYPES,
  UnknownReferenceError,
  interactionSchema,
  recordInteraction,
} from '../reco/interactions.ts';
import { getUserProfile, rebuildUserProfile } from '../reco/profile.ts';
import { EVENT_WEIGHTS, invalidatesFeed } from '../reco/signals.ts';
import { RedisUnavailableError, invalidateFeed } from '../feed/cache.ts';
import { InvalidCursorError } from '../feed/cursor.ts';
import { FeedGoneError, getFeedPage } from '../feed/service.ts';
import { closeFeedQueue, enqueueFeedBuild } from '../feed/queue.ts';
import { registerDemoRoutes } from './demo.ts';

/**
 * HTTP surface.
 *
 * Two kinds of route live here, and the difference matters:
 *
 *   - the API proper - `/feed`, `/interactions`, `/users/:id/profile`, `/signals`,
 *     `/health`, `/ready`;
 *   - the demo surface under `/demo`, which is a local demonstration of that API and
 *     not part of it. See `api/demo.ts`.
 *
 * `GET /feed` is the hot path and reads Redis only. The profile rebuild on
 * `POST /interactions` runs inline: with one user's history that is a few
 * milliseconds, and it keeps the demo honest - post a like, read the profile, see it
 * move. Production moves it to a queue (see ARCHITECTURE.md), which is why the
 * rebuild is a separate function call rather than inlined logic.
 */

export interface ServerOptions {
  /** Off for tests and scripted demos, where request logs bury the output. */
  logger?: boolean;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const enableLogger = options.logger ?? env.NODE_ENV !== 'test';
  const app = Fastify({
    logger: enableLogger ? { level: env.LOG_LEVEL } : false,
  });

  /** Liveness. Deliberately cheap - it answers "is this process up?", nothing more. */
  app.get('/health', async () => ({
    status: 'ok',
    taxonomyVersion: TAXONOMY_VERSION,
    taxonomyDim: TAXONOMY_DIM,
  }));

  /**
   * Readiness, kept separate from liveness on purpose. A load balancer should stop
   * sending traffic to a replica whose dependencies are down without also killing
   * it; folding these checks into /health would do exactly that.
   */
  app.get('/ready', async (_request, reply) => {
    const checks = { redis: false, postgres: false };

    try {
      await cacheConnection().ping();
      checks.redis = true;
    } catch {
      // Reported, not thrown: the point of this endpoint is to say which one failed.
    }
    try {
      await db.execute(sql`select 1`);
      checks.postgres = true;
    } catch {
      // Same.
    }

    const ready = checks.redis && checks.postgres;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });

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

      // Two separate facts. The cache can be invalidated while the rebuild fails to
      // queue, and reporting that as a single boolean would claim the feed was left
      // untouched when it was not.
      let feedInvalidated = false;
      let rebuildQueued = false;
      if (result.recorded && invalidatesFeed(parsed.data.type)) {
        // Two conditions, for two different reasons.
        //
        // `result.recorded` - a duplicate changed nothing, so bumping the epoch
        // again would throw away a valid feed and queue a rebuild producing the
        // same list.
        //
        // `invalidatesFeed` - an `impression` is recorded and makes the video seen
        // for the next build, but must not force a rebuild now. A client showing
        // ten items sends ten impressions; since the epoch is the deduplication
        // key, invalidating on each would mean ten separate builds. See
        // reco/signals.ts for the freshness-versus-amplification trade.
        //
        // Redis and the queue are a side effect here. The interaction is already
        // durable in Postgres and must stay successful even if the refresh fails;
        // the alternative - failing the write because a cache could not be
        // invalidated - loses user data to protect a derived artefact. Production
        // would close this gap with a transactional outbox rather than by making
        // the two writes one transaction.
        try {
          // Invalidate first, queue second. The order is what makes a partial
          // failure safe: if the enqueue then fails, the user is left with a cache
          // miss that the next GET repairs, never with a feed that predates their
          // interaction. The reverse order could leave a queued rebuild racing a
          // still-live stale pointer.
          const epoch = await invalidateFeed(parsed.data.userId);
          feedInvalidated = true;

          await enqueueFeedBuild({
            userId: parsed.data.userId,
            epoch,
            reason: 'invalidation',
          });
          rebuildQueued = true;
        } catch (error) {
          request.log.error(
            { err: error, userId: parsed.data.userId, feedInvalidated },
            'interaction stored, feed refresh incomplete',
          );
        }
      }

      return reply.code(result.recorded ? 201 : 200).send({
        recorded: result.recorded,
        duplicate: !result.recorded,
        feedInvalidated,
        rebuildQueued,
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

  const feedQuery = z.object({
    userId: z.string().uuid(),
    // Capped at the built feed size: a client cannot ask for more than one
    // generation holds, and an unbounded limit would let one request serialise an
    // arbitrarily large payload.
    limit: z.coerce.number().int().min(1).max(env.FEED_SIZE).default(10),
    cursor: z.string().max(512).optional(),
  });

  /**
   * The hot path. Redis only - there is no code path from here to Postgres,
   * pgvector or the ranker, which is the property the 3k RPS design rests on.
   */
  app.get('/feed', async (request, reply) => {
    const query = feedQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        issues: query.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { userId, limit, cursor } = query.data;

    try {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!user) return reply.code(404).send({ error: 'unknown_user' });

      const page = await getFeedPage({ userId, limit, cursor });

      if (page.status === 'building') {
        return reply
          .code(202)
          .header('Retry-After', '1')
          .send({ status: 'building', retryAfterMs: page.retryAfterMs });
      }

      return reply.code(200).send({
        status: 'ready',
        feedId: page.feedId,
        generatedAt: page.generatedAt,
        coldStart: page.coldStart,
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return reply.code(400).send({ error: 'invalid_cursor', message: error.reason });
      }
      if (error instanceof FeedGoneError) {
        // Distinct from 400: the cursor was well-formed and simply outlived its
        // generation. The machine-readable code tells a client to restart the
        // session without a cursor rather than to fix its request.
        return reply.code(410).send({ error: error.code, message: error.message });
      }
      if (error instanceof RedisUnavailableError) {
        // No synchronous recommendation fallback. Computing a feed in the API
        // process would turn a cache outage into a database stampede.
        return reply
          .code(503)
          .header('Retry-After', '1')
          .send({ error: 'feed_cache_unavailable' });
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

  registerDemoRoutes(app);

  return app;
}

async function main(): Promise<void> {
  const app = buildServer();
  const close = async (): Promise<void> => {
    // Every handle the process owns, or tests and containers hang on shutdown.
    await app.close();
    await closeFeedQueue();
    await closeRedis();
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
