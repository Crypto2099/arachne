import { defineConfig } from 'vitest/config';

// Three projects, because the three things Arachne checks fail for different
// reasons and must be runnable apart. `unit` and `conformance` are offline and
// deterministic; `chain` submits real transactions to a public testnet and is
// never part of the default run. See spec/05-conformance.md.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'conformance',
          include: ['test/conformance/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'chain',
          include: ['test/chain/**/*.test.ts'],
          environment: 'node',
          testTimeout: 600_000,
          hookTimeout: 600_000,
          // One process, one file at a time: these share a funding wallet, and
          // concurrent submissions from one address collide on UTxO selection.
          poolOptions: { forks: { singleFork: true } },
          sequence: { concurrent: false },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/**/index.ts'],
    },
  },
});
