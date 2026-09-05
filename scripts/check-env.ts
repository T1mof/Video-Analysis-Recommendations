import { readFile } from 'node:fs/promises';

/**
 * Guards against .env drifting from .env.example.
 *
 * This is not hypothetical: during M3 a stale .env - copied at M0 and never
 * updated - silently overrode newer defaults with obsolete frame-budget values,
 * and the symptom was a failing test rather than anything pointing at config. The
 * file is gitignored, so nothing else catches it.
 *
 * A reviewer cloning the repository copies .env.example and is fine; this check
 * protects the person who has been running the project for a week.
 */

const SECRET_PATTERN = /(_KEY|_SECRET|_TOKEN|_PASSWORD)$/;

async function keysOf(path: string): Promise<Set<string>> {
  const text = await readFile(path, 'utf8');
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

async function main(): Promise<void> {
  const example = await keysOf('.env.example');

  let local: Set<string>;
  try {
    local = await keysOf('.env');
  } catch {
    console.log('.env not present - nothing to compare. Copy .env.example to start.');
    return;
  }

  const missingLocally = [...example].filter((key) => !local.has(key)).sort();
  const extraLocally = [...local].filter((key) => !example.has(key)).sort();

  console.log(`.env.example  ${example.size} keys`);
  console.log(`.env          ${local.size} keys`);

  if (missingLocally.length > 0) {
    console.log(
      `\nMissing from .env (${missingLocally.length}) - these fall back to code defaults,\n` +
        `which is usually fine but means .env no longer documents the running config:`,
    );
    for (const key of missingLocally) console.log(`  - ${key}`);
  }

  if (extraLocally.length > 0) {
    const secrets = extraLocally.filter((key) => SECRET_PATTERN.test(key));
    const stale = extraLocally.filter((key) => !SECRET_PATTERN.test(key));

    if (stale.length > 0) {
      console.log(
        `\nIn .env but not in .env.example (${stale.length}) - likely removed from the\n` +
          `schema and now dead, or added without documenting:`,
      );
      for (const key of stale) console.log(`  - ${key}`);
    }
    if (secrets.length > 0) {
      console.log(`\nLocal secrets (expected, not documented on purpose):`);
      for (const key of secrets) console.log(`  - ${key}`);
    }
  }

  const stale = extraLocally.filter((key) => !SECRET_PATTERN.test(key));
  if (missingLocally.length === 0 && stale.length === 0) {
    console.log('\n.env and .env.example agree.');
    return;
  }

  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
