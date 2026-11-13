import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const monorepoRoot = path.join(import.meta.dirname, '../..');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  // The Docker image runs `node apps/web/server.js` from the standalone output.
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@shotx/shared', '@shotx/ui'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Security headers (including the per-request CSP nonce) are set in src/proxy.ts.
  headers() {
    return Promise.resolve([
      {
        // The scan's face detector (MediaPipe wasm, ~4 MB gzipped, and its model): kept on the
        // phone for 30 days instead of revalidated on every visit. Not `immutable`: the names
        // carry no hash, so an upgrade reaches phones within the month (a mismatch only turns
        // the on-phone check off; the API still checks every selfie).
        source: '/mediapipe/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=2592000, stale-while-revalidate=86400',
          },
        ],
      },
    ]);
  },
};

export default withNextIntl(config);
