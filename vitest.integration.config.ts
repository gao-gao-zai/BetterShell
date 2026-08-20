import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**'],
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
  },
});
