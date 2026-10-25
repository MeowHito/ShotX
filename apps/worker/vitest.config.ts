import { defineConfig } from 'vitest/config';

// The full repo runs every package's tests in parallel (turbo), so PGlite start-up plus the
// migrations, sharp and ffmpeg can take far longer than vitest's defaults (10 s hooks, 5 s
// tests). Generous limits keep that load from turning into flaky timeouts.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
