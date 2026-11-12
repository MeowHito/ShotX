import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(import.meta.dirname, 'src'),
      // `server-only` throws outside React Server Components; tests import server modules directly.
      'server-only': path.join(import.meta.dirname, 'test/server-only.ts'),
      // next/font loads fonts at build time inside Next only; tests get named stand-in faces.
      'next/font/google': path.join(import.meta.dirname, 'test/next-font-google.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
