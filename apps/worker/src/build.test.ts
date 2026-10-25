import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Next to dist/main.js, so the bundle resolves its external packages from apps/worker/node_modules
// exactly as the image does.
const outfile = join('dist', 'build-check', 'main.js');

describe('JavaScript build', () => {
  afterAll(async () => {
    await rm(join(root, 'dist', 'build-check'), { recursive: true, force: true });
  });

  it('bundles to plain JavaScript that node runs without tsx', async () => {
    const build = spawnSync(process.execPath, ['build.mjs', outfile], { cwd: root });
    expect(build.status, build.stderr.toString()).toBe(0);
    const code = await readFile(join(root, outfile), 'utf8');
    // Workspace TypeScript is bundled; node_modules stay external.
    expect(code).not.toMatch(/from ["']@shotx\//);
    expect(code).toMatch(/from ["']sharp["']/);
    expect(code).toMatch(/from ["']archiver["']/);

    // Every module loads (sharp's native binary, archiver, the AWS SDK, @shotx/* code), then main
    // rejects the empty environment with its structured start-up error and no secrets.
    const run = spawnSync(process.execPath, ['--enable-source-maps', outfile], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      timeout: 30_000,
    });
    expect(run.status).toBe(1);
    const line = JSON.parse(run.stderr.toString().trim().split('\n').at(-1)!) as {
      level: string;
      msg: string;
    };
    expect(line).toMatchObject({ level: 'error', msg: 'worker failed to start' });
  });
});
