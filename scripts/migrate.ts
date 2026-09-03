import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';

/**
 * pgvector must exist before the generated migrations reference vector columns,
 * and drizzle-kit does not emit CREATE EXTENSION - so it happens here.
 */
async function main(): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  console.log('pgvector extension ready');

  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  console.log('migrations applied');

  await closeDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
