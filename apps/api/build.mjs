// Bundles the API into dist/main.js. Workspace packages (@shotx/*) ship TypeScript sources, so
// they are bundled; every other package stays external and is installed in the image.
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
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // NestJS legacy decorators (tsconfig experimentalDecorators).
  tsconfig: 'tsconfig.json',
  plugins: [externalizeNodeModules],
  logLevel: 'info',
});
