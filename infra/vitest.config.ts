import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesizing every stack takes several seconds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
