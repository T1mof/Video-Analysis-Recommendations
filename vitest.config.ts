import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests that need Postgres/Redis/MinIO opt in explicitly via
    // TEST_INTEGRATION=1; the default suite stays runnable with no services up.
    exclude: ['node_modules/**', 'dist/**'],
    /**
     * One file at a time.
     *
     * The integration files share a single Postgres. Per-file id prefixes keep
     * their own rows apart, but some behaviour is a *global* aggregate - trending
     * popularity is normalised across every event in the window - so a second file
     * inserting events mid-run changes what the first one measures. That produced a
     * genuinely flaky failure rather than a wrong result.
     *
     * Costs a few seconds on a suite that runs in under ten. Worth it for tests
     * whose failures can be trusted.
     */
    fileParallelism: false,
  },
});
