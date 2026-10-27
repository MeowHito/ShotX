import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { REKOGNITION_INLINE_MAX_BYTES } from '@shotx/face';
import { type Env, loadFaceConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import type { Dataset } from './dataset';
import { LEGACY_S3_MAX_BYTES } from './encoding';
import { PACKAGE_DIR } from './paths';
import {
  assertProviderAllowed,
  AWS_ACKNOWLEDGEMENT,
  createProvider,
  evaluationClientConfig,
  rekognitionRegionalEndpoint,
} from './providers';

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

/** An evaluation account's keys, as on the owner's machine (AWS-shaped, not real). */
const evalKeys: Env = {
  REKOGNITION_REGION: 'ap-southeast-1',
  REKOGNITION_ACCESS_KEY_ID: 'AKIAEVALUATIONTEST01',
  REKOGNITION_SECRET_ACCESS_KEY: 'evaluation-secret-not-real',
};
/** The local .env: LocalStack for everything. */
const localDotEnv: Env = {
  APP_STAGE: 'local',
  AUTH_PROVIDER: 'local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  REKOGNITION_ENDPOINT_URL: 'http://localhost:4566',
  REKOGNITION_ACCESS_KEY_ID: 'test',
  REKOGNITION_SECRET_ACCESS_KEY: 'test',
};

describe('evaluationClientConfig', () => {
  const keys = {
    accessKeyId: 'AKIAEVALUATIONTEST01',
    secretAccessKey: 'evaluation-secret-not-real',
  };

  it('takes the evaluation account keys and always sets the regional endpoint explicitly', () => {
    expect(evaluationClientConfig(evalKeys)).toEqual({
      region: 'ap-southeast-1',
      endpointUrl: 'https://rekognition.ap-southeast-1.amazonaws.com',
      credentials: keys,
    });
  });

  it('keeps an AWS REKOGNITION_ENDPOINT_URL', () => {
    const fips = 'https://rekognition-fips.us-east-1.amazonaws.com';
    expect(
      evaluationClientConfig({
        ...evalKeys,
        REKOGNITION_REGION: 'us-east-1',
        REKOGNITION_ENDPOINT_URL: fips,
      }),
    ).toMatchObject({ region: 'us-east-1', endpointUrl: fips });
  });

  it('never falls back to the default credential chain', () => {
    expect(() => evaluationClientConfig({ REKOGNITION_REGION: 'ap-southeast-1' })).toThrow(
      /never uses the default AWS credential chain/,
    );
  });

  it('refuses the LocalStack endpoint of the local .env', () => {
    expect(() => evaluationClientConfig(localDotEnv)).toThrow(/not AWS/);
  });

  // An explicit endpoint wins over AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_REKOGNITION and a profile's
  // endpoint_url, which the SDK applies only to clients without one; also on APP_STAGE=local.
  it('pins the endpoint even when the environment would redirect the SDK', () => {
    const redirecting: Env = {
      ...localDotEnv,
      ...evalKeys,
      REKOGNITION_ENDPOINT_URL: undefined,
      AWS_ENDPOINT_URL_REKOGNITION: 'http://localhost:1',
    };
    expect(evaluationClientConfig(redirecting).endpointUrl).toBe(
      'https://rekognition.ap-southeast-1.amazonaws.com',
    );
  });

  it('builds the regional endpoint for every partition', () => {
    expect(rekognitionRegionalEndpoint('ap-southeast-1')).toBe(
      'https://rekognition.ap-southeast-1.amazonaws.com',
    );
    expect(rekognitionRegionalEndpoint('cn-north-1')).toBe(
      'https://rekognition.cn-north-1.amazonaws.com.cn',
    );
  });
});

describe('createProvider', () => {
  const config = loadFaceConfig({});
  const base = { config, env: evalKeys, maxIndexBytes: config.index.maxBytes };

  it('refuses Rekognition without the flag before building a client', () => {
    expect(() =>
      createProvider({ ...base, name: 'rekognition', acknowledged: false, dataset: realDataset }),
    ).toThrow(`--${AWS_ACKNOWLEDGEMENT}`);
  });

  it('only runs the fake provider on synthetic datasets', () => {
    expect(() =>
      createProvider({ ...base, name: 'fake', acknowledged: false, dataset: realDataset }),
    ).toThrow(/synthetic datasets/);
  });

  it('refuses byte limits above 5 MiB for Rekognition: the S3 path is gone', () => {
    expect(() =>
      createProvider({
        ...base,
        name: 'rekognition',
        acknowledged: true,
        dataset: realDataset,
        maxIndexBytes: LEGACY_S3_MAX_BYTES,
      }),
    ).toThrow(/face-eval encode/);
  });

  it('builds Rekognition from the REKOGNITION_* settings without calling it', () => {
    const setup = createProvider({
      ...base,
      name: 'rekognition',
      acknowledged: true,
      dataset: realDataset,
    });
    expect(setup.maxImageBytes).toBe(REKOGNITION_INLINE_MAX_BYTES);
    expect(setup.description).toContain('endpoint rekognition.ap-southeast-1.amazonaws.com');
    expect(setup.description).toContain('as bytes');
    const option = {
      longEdge: 3500,
      maxBytes: 5242880,
      qualityFilter: 'LOW',
      tiling: 'never',
    } as const;
    // One provider for every option; collections named with the byte limit.
    expect(setup.providerFor(option)).toBe(setup.providerFor({ ...option, longEdge: 2400 }));
    expect(setup.collectionKey(option)).toBe('le3500-5mib-low-never');
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
