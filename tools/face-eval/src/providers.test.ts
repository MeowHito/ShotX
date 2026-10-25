import { spawnSync } from 'node:child_process';
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

describe('cli', () => {
  const tsx = resolve(PACKAGE_DIR, '../../node_modules/.bin/tsx');
  const cli = resolve(PACKAGE_DIR, 'src/cli.ts');

  it('exits with an error when Rekognition is requested without the flag', () => {
    const run = spawnSync(tsx, [cli, 'run', '--provider', 'rekognition'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`--${AWS_ACKNOWLEDGEMENT}`);
  });

  it('prints usage', () => {
    const run = spawnSync(tsx, [cli, 'help'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('pnpm face-eval synth');
  });
});
