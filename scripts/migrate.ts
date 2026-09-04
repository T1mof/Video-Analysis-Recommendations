import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { TAXONOMY_DIM, TAXONOMY_VERSION } from '../src/analysis/taxonomy.ts';

/**
 * pgvector must exist before the generated migrations reference vector columns,
 * and drizzle-kit does not emit CREATE EXTENSION - so it happens here.
 */
async function main(): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  console.log('pgvector extension ready');

  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  console.log('migrations applied');

  await assertVectorDimensions();

  await closeDb();
}

/**
 * The vector dimension lives in two places that can drift: TAXONOMY_LAYOUT in the
 * code, and the PostgreSQL column type. A `vector(83)` column cannot store an
 * 84-dimensional vector, and pgvector refuses distance operations across
 * mismatched dimensions - so a drift here surfaces as confusing insert/query
 * failures much later. Check it at migrate time and say exactly what to do.
 */
async function assertVectorDimensions(): Promise<void> {
  const rows = await db.execute<{ table_name: string; type: string }>(sql`
    SELECT c.relname AS table_name,
           format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE a.attname = 'embedding'
      AND c.relname IN ('video_embeddings', 'user_profiles')
  `);

  const mismatches = [...rows].filter((row) => row.type !== `vector(${TAXONOMY_DIM})`);

  if (mismatches.length > 0) {
    const detail = mismatches.map((r) => `  ${r.table_name}: ${r.type}`).join('\n');
    throw new Error(
      `Vector dimension mismatch. Code expects vector(${TAXONOMY_DIM}) at taxonomy ` +
        `v${TAXONOMY_VERSION}, database has:\n${detail}\n\n` +
        `Changing TAXONOMY_DIM requires the full procedure:\n` +
        `  1. npx drizzle-kit generate   (emits the vector(N) column change)\n` +
        `  2. npm run db:migrate\n` +
        `  3. re-encode all video_embeddings from video_features.raw\n` +
        `  4. re-encode all user_profiles (a profile is a sum of video vectors)\n` +
        `  5. rebuild the HNSW index\n` +
        `See ARCHITECTURE.md "Taxonomy versioning and re-embedding".`,
    );
  }

  console.log(
    `vector dimensions verified: vector(${TAXONOMY_DIM}) at taxonomy v${TAXONOMY_VERSION}`,
  );
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDb();
  process.exit(1);
});
