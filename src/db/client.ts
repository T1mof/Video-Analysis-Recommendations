import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.ts';
import * as schema from './schema.ts';

/**
 * One pooled connection per process. The API and the workers are separate
 * processes, so each gets its own pool - which is also how they scale
 * independently in the production design.
 */
export const sqlClient = postgres(env.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
});

export const db = drizzle(sqlClient, { schema });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await sqlClient.end({ timeout: 5 });
}
