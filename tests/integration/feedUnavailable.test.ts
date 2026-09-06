import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type * as ConnectionModule from '../../src/queue/connection.ts';

/**
 * What happens when the feed cache is down.
 *
 * The answer must be a controlled 503, never a synchronous recommendation. The
 * temptation during an outage is to "just compute it this once" - which converts a
 * Redis failure into a database stampede at exactly the moment the system is least
 * able to absorb one. This pins that decision down with a test.
 *
 * Redis is made unreachable by pointing the cache connection at a closed port,
 * which exercises the real error path rather than a stubbed rejection.
 */
const deadClients: Redis[] = [];

vi.mock('../../src/queue/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    cacheConnection: () => {
      const client = new Redis('redis://127.0.0.1:6399', {
        maxRetriesPerRequest: 0,
        connectTimeout: 200,
        commandTimeout: 200,
        enableOfflineQueue: false,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      client.on('error', () => {});
      deadClients.push(client);
      return client;
    },
  };
});

const { closeDb, db } = await import('../../src/db/client.ts');
const { users } = await import('../../src/db/schema.ts');
const { buildServer } = await import('../../src/api/server.ts');
const { closeRedis } = await import('../../src/queue/connection.ts');
const { closeFeedQueue } = await import('../../src/feed/queue.ts');

const enabled = process.env.TEST_INTEGRATION === '1';

const PREFIX = 'fdown_';
let userId: string;
let app: FastifyInstance;

beforeAll(async () => {
  if (!enabled) return;
  const [user] = await db
    .insert(users)
    .values({ label: `${PREFIX}user` })
    .returning({ id: users.id });
  userId = user!.id;

  app = buildServer({ logger: false });
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  if (userId) await db.delete(users).where(eq(users.id, userId));
  for (const client of deadClients) client.disconnect();
  await closeFeedQueue();
  await closeRedis();
  await closeDb();
}, 60_000);

describe.skipIf(!enabled)('feed cache unavailable', () => {
  it('answers 503 instead of computing a feed', async () => {
    const response = await app.inject({ method: 'GET', url: `/feed?userId=${userId}` });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('feed_cache_unavailable');
    expect(response.headers['retry-after']).toBeDefined();
  }, 30_000);

  it('still validates the request before reporting the outage', async () => {
    // A malformed request is the client's problem regardless of cache health.
    expect(
      (await app.inject({ method: 'GET', url: `/feed?userId=${userId}&limit=0` })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/feed?userId=00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
  }, 30_000);

  it('reports readiness as degraded while the cache is unreachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json().checks.redis).toBe(false);
    // Liveness stays green: the process is fine, its dependency is not.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  }, 30_000);
});
