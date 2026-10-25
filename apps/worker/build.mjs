// Bundles the worker into dist/main.js, so the production image runs plain JavaScript (no tsx).
// Workspace packages (@shotx/*) ship TypeScript sources, so they are bundled; every other package
// stays external and is installed in the image (sharp and its native binary included).
//
//   node build.mjs [outfile]      default dist/main.js
import process from 'node:process';
import { build } from 'esbuild';

/** @type {import('esbuild').Plugin} */
const externalizeNodeModules = {
  name: 'externalize-node-modules',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith('@shotx/') ? undefined : { path: args.path, external: true },
    );
  },
};

await build({
  entryPoints: ['src/main.ts'],
  outfile: process.argv[2] ?? 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  plugins: [externalizeNodeModules],
  logLevel: 'info',
});
