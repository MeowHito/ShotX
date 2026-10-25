import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { loadFaceConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import type { Dataset } from './dataset';
import { PACKAGE_DIR } from './paths';
import { assertProviderAllowed, AWS_ACKNOWLEDGEMENT, createProvider } from './providers';

const realDataset: Dataset = {
  dir: '/nowhere',
  event: undefined,
  photos: [],
  persons: [],
  synthetic: undefined,
};

describe('assertProviderAllowed', () => {
  it('allows the fake provider without any flag', () => {
    expect(assertProviderAllowed('fake', false)).toBe('fake');
  });

  it('refuses Rekognition unless the AWS acknowledgement flag is set', () => {
    expect(() => assertProviderAllowed('rekognition', false)).toThrow(`--${AWS_ACKNOWLEDGEMENT}`);
    expect(assertProviderAllowed('rekognition', true)).toBe('rekognition');
  });

  it('rejects unknown providers', () => {
    expect(() => assertProviderAllowed('insightface', true)).toThrow(/Unknown provider/);
  });
});

describe('createProvider', () => {
  const config = loadFaceConfig({});

  it('refuses Rekognition without the flag before building a client', () => {
    expect(() =>
      createProvider({ name: 'rekognition', acknowledged: false, dataset: realDataset, config }),
    ).toThrow(`--${AWS_ACKNOWLEDGEMENT}`);
  });

  it('only runs the fake provider on synthetic datasets', () => {
    expect(() =>
      createProvider({ name: 'fake', acknowledged: false, dataset: realDataset, config }),
    ).toThrow(/synthetic datasets/);
  });
});

/**
 * Spawning tsx compiles the CLI first, which takes well under a second alone but several seconds
 * when the whole monorepo's tests run in parallel. These tests get a generous explicit timeout,
 * and the child is spawned asynchronously (not spawnSync) so it never blocks the test runner and
 * is killed if it hangs.
 */
const CLI_TEST_TIMEOUT_MS = 60_000;
const CLI_KILL_AFTER_MS = 50_000;

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(tsx: string, args: string[]): Promise<CliRun> {
  return new Promise((done) => {
    execFile(
      tsx,
      args,
      { encoding: 'utf8', timeout: CLI_KILL_AFTER_MS },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? null : 0;
        done({ status: code, stdout, stderr });
      },
    );
  });
}

describe('cli', () => {
  const tsx = resolve(PACKAGE_DIR, '../../node_modules/.bin/tsx');
  const cli = resolve(PACKAGE_DIR, 'src/cli.ts');

  it(
    'exits with an error when Rekognition is requested without the flag',
    async () => {
      const run = await runCli(tsx, [cli, 'run', '--provider', 'rekognition']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`--${AWS_ACKNOWLEDGEMENT}`);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'prints usage',
    async () => {
      const run = await runCli(tsx, [cli, 'help']);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('pnpm face-eval synth');
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
