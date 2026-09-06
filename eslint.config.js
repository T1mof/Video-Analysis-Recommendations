// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/db/migrations/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The demo page. Linted rather than ignored - it is the surface a reviewer
    // actually opens, and unlinted code is where typos go to hide. Browser globals
    // are listed explicitly instead of pulling in the `globals` package for seven
    // names. It is a classic script, not a module: no build step, no bundler.
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        console: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        window: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
);
