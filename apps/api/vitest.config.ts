import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite migrations and RSA key generation take a few seconds per file.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
