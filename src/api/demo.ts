import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { RedisUnavailableError, readFeedDebug } from '../feed/cache.ts';
import { posterKey, presignGet, videoKey } from '../storage/s3.ts';

/**
 * The demo surface.
 *
 * A local demonstration UI and one read-only endpoint behind it. This is **not**
 * production API: it exposes ranking internals that a real client has no business
 * seeing, and a deployment would either gate it behind a flag or simply not ship it.
 * The MVP mounts it unconditionally because the demo is the deliverable; that trade
 * is recorded in ARCHITECTURE.md rather than left implicit.
 *
 * The constraint that shapes this file: **the demo must not become a second, slower
 * way to recommend.** `/demo/api/feed-debug` reads one Redis key and signs URLs. It
 * does not import the recommender, does not query Postgres, does not rank, and
 * changes no state. Everything it returns was computed once by the feed worker at
 * build time. A test makes the recommender throw to keep it that way.
 *
 * The page itself is a client of the ordinary API - `GET /feed`, `POST
 * /interactions`, `GET /users/:id/profile` - so what a reviewer sees in the browser
 * is the real serving path, not a demo-only shortcut around it.
 */

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

const debugQuery = z.object({
  userId: z.string().uuid(),
  feedId: z.string().uuid(),
});

export function registerDemoRoutes(app: FastifyInstance): void {
  void app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/demo/',
    index: 'index.html',
  });

  // `/demo` without the trailing slash, which is what anyone actually types.
  app.get('/demo', async (_request, reply) => reply.code(302).header('location', '/demo/').send());

  /**
   * The explanation for one generation, plus the display metadata the page needs to
   * render a card. Both are demo concerns and both are already in the sidecar, so
   * they travel together rather than as two round trips.
   */
  app.get('/demo/api/feed-debug', async (request, reply) => {
    const query = debugQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        issues: query.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { userId, feedId } = query.data;

    try {
      const debug = await readFeedDebug(userId, feedId);

      // The Redis key is built from both ids, so a mismatched pair cannot address
      // another user's data in the first place. The stored `userId` is checked
      // anyway: the binding should be an assertion in the code, not an inference
      // from how a key happens to be spelled.
      if (!debug || debug.userId !== userId) {
        // Two different "no explanation" cases, told apart so the page can say which.
        // The read itself is never gated on the flag - if a sidecar exists it is
        // served - because the flag governs what the *worker writes*, which is where
        // the memory cost actually is.
        const disabled = !env.FEED_DEBUG_SIDECAR;
        return reply.code(404).send({
          available: false,
          sidecarEnabled: env.FEED_DEBUG_SIDECAR,
          error: disabled ? 'debug_sidecar_disabled' : 'no_debug_data',
          ...(disabled
            ? { hint: 'Set FEED_DEBUG_SIDECAR=true and rebuild the feed to see explanations.' }
            : {}),
        });
      }

      // Signing is local HMAC work - no network call, no database read. The API hands
      // out storage URLs and never proxies bytes, which is the same property the 3k
      // RPS design depends on; the demo exercises it rather than describing it.
      //
      // Keys are derived from the video id because that is exactly what ingestion
      // wrote (`s3Key: videoKey(id)`, `thumbKey: posterKey(id)`). Deriving them keeps
      // this endpoint free of a Postgres read; the cost is that a corpus stored under
      // different keys would produce URLs that 404, which the page renders as "no
      // media" rather than as an error.
      const items = await Promise.all(
        debug.items.map(async (item) => ({
          ...item,
          posterUrl: await presignGet(posterKey(item.videoId)),
          mediaUrl: await presignGet(videoKey(item.videoId)),
        })),
      );

      return reply.send({ available: true, sidecarEnabled: env.FEED_DEBUG_SIDECAR, ...debug, items });
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        return reply.code(503).send({ available: false, error: 'feed_cache_unavailable' });
      }
      throw error;
    }
  });
}
