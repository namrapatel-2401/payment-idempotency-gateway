import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration suites own independent Testcontainers instances and the
    // application database module contains a process-level Knex singleton.
    // Separate OS processes prevent parallel suites from closing each
    // other's pools or changing each other's environment configuration.
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/migrations/',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
