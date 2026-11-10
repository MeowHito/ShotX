import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const monorepoRoot = path.join(import.meta.dirname, '../..');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  // The Docker image runs `node apps/admin/server.js` from the standalone output.
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@shotx/shared', '@shotx/ui'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Security headers (including the per-request CSP nonce and X-Robots-Tag) are set in src/proxy.ts.
};

export default withNextIntl(config);
