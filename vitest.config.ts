import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests that need Postgres/Redis/MinIO opt in explicitly via
    // TEST_INTEGRATION=1; the default suite stays runnable with no services up.
    exclude: ['node_modules/**', 'dist/**'],
  },
});
