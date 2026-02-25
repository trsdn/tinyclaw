import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server/index.ts'],
    },
    testTimeout: 30000,
    hookTimeout: 10000,
    sequence: {
      shuffle: false,
    },
  },
});
