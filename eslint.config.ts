import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Driver scripts under src/compat/adapters are payloads copied into a
    // scratch npm install and run there as plain Node subprocesses, next to
    // whatever version of a third-party package is under test. They are
    // deliberately outside this project's own module graph, the same reason
    // vectors/** (generated data, not source) is excluded here.
    ignores: [
      'dist/**',
      'coverage/**',
      'vectors/**',
      'node_modules/**',
      'src/compat/adapters/*-driver.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    files: ['src/cli.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
