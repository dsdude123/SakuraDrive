import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@sakuradrive/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Catalog scan tests touch the filesystem; give them room without hiding hangs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
