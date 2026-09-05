import { closeDb, db } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';

/**
 * Demo users.
 *
 * Fixed UUIDs rather than generated ones so the script is idempotent and so the
 * demo, the simulation and any manual curl command all address the same rows
 * across runs.
 */
export const DEMO_USERS = [
  { id: '11111111-1111-4111-8111-111111111111', label: 'demo_alice' },
  { id: '22222222-2222-4222-8222-222222222222', label: 'demo_bob' },
  /** Barely any history - exists to show the cold-start branch. */
  { id: '33333333-3333-4333-8333-333333333333', label: 'demo_carol' },
] as const;

export async function seedUsers(): Promise<void> {
  for (const user of DEMO_USERS) {
    await db.insert(users).values(user).onConflictDoNothing({ target: users.id });
  }
}

async function main(): Promise<void> {
  await seedUsers();
  console.log(`seeded ${DEMO_USERS.length} demo users:`);
  for (const user of DEMO_USERS) console.log(`  ${user.label}  ${user.id}`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed-users.ts')) {
  main()
    .then(() => closeDb())
    .catch(async (error: unknown) => {
      console.error(error);
      await closeDb();
      process.exit(1);
    });
}
