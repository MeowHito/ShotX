import { describe, expect, it } from 'vitest';
import {
  type AclGrant,
  applyPlan,
  type BucketApi,
  checkPublicAccess,
  type PublicAccessBlock,
  type Read,
  type SetupPlan,
} from '../r2/bucket';
import type { CorsRule, ReadLifecycleRule } from '../r2/rules';
import { prepareSetup } from '../r2/setup-bucket';

const ok = <T>(value: T): Read<T> => ({ state: 'ok', value });
const ALL_BLOCKED: PublicAccessBlock = {
  BlockPublicAcls: true,
  IgnorePublicAcls: true,
  BlockPublicPolicy: true,
  RestrictPublicBuckets: true,
};

interface FakeState {
  block: Read<PublicAccessBlock>;
  policyPublic: Read<boolean>;
  acl: Read<AclGrant[]>;
  anonymous: Read<number>;
  cors: Partial<CorsRule>[] | null;
  lifecycle: ReadLifecycleRule[] | null;
  corsSupported: boolean;
  /** Simulates a store that drops what it is given. */
  ignoreWrites: boolean;
}

function fakeBucket(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    block: ok(ALL_BLOCKED),
    policyPublic: ok(false),
    acl: ok([{ permission: 'FULL_CONTROL' }]),
    anonymous: ok(403),
    cors: null,
    lifecycle: [
      {
        ID: 'Default Multipart Abort Rule',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      },
    ],
    corsSupported: true,
    ignoreWrites: false,
    ...overrides,
  };
  const puts = { cors: 0, lifecycle: 0 };
  const api: BucketApi = {
    bucket: 'shotx-prod-media',
    getPublicAccessBlock: () => Promise.resolve(state.block),
    getPolicyIsPublic: () => Promise.resolve(state.policyPublic),
    getAclGrants: () => Promise.resolve(state.acl),
    anonymousListStatus: () => Promise.resolve(state.anonymous),
    getCors: () =>
      Promise.resolve(
        !state.corsSupported
          ? { state: 'unsupported' }
          : state.cors === null
            ? { state: 'absent' }
            : ok(state.cors),
      ),
    putCors: (rules) => {
      puts.cors += 1;
      if (!state.ignoreWrites) state.cors = structuredClone(rules);
      return Promise.resolve();
    },
    getLifecycle: () =>
      Promise.resolve(state.lifecycle === null ? { state: 'absent' } : ok(state.lifecycle)),
    putLifecycle: (rules) => {
      puts.lifecycle += 1;
      if (!state.ignoreWrites) state.lifecycle = structuredClone(rules);
      return Promise.resolve();
    },
  };
  return { api, puts, state };
}

const plan: SetupPlan = {
  cors: [
    {
      ID: 'upload-parts',
      AllowedOrigins: ['https://photos.example.com'],
      AllowedMethods: ['PUT'],
      AllowedHeaders: ['content-type'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3000,
    },
  ],
  lifecycle: [
    {
      ID: 'expire-tmp-other',
      Status: 'Enabled',
      Filter: { Prefix: 'tmp/' },
      Expiration: { Days: 3 },
    },
  ],
};

describe('public access checks', () => {
  it('passes a private bucket', async () => {
    const { api } = fakeBucket();
    expect(await checkPublicAccess(api, { r2: false })).toEqual({ problems: [], unknown: [] });
  });

  it('refuses every public signal it can see', async () => {
    const { api } = fakeBucket({
      block: ok({ ...ALL_BLOCKED, BlockPublicPolicy: false }),
      policyPublic: ok(true),
      acl: ok([
        { permission: 'READ', granteeUri: 'http://acs.amazonaws.com/groups/global/AllUsers' },
      ]),
      anonymous: ok(200),
    });
    const { problems } = await checkPublicAccess(api, { r2: false });
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(
      /BlockPublicPolicy[\s\S]*policy[\s\S]*AllUsers[\s\S]*HTTP 200/,
    );
  });

  it('treats a missing Block Public Access as public except on R2, which has none', async () => {
    const { api } = fakeBucket({ block: { state: 'absent' } });
    expect((await checkPublicAccess(api, { r2: false })).problems).toHaveLength(1);
    expect((await checkPublicAccess(api, { r2: true })).problems).toEqual([]);
  });

  it('reports what an R2-like store cannot answer', async () => {
    const unsupported = { state: 'unsupported' } as const;
    const { api } = fakeBucket({
      block: unsupported,
      policyPublic: unsupported,
      acl: unsupported,
    });
    const report = await checkPublicAccess(api, { r2: true });
    expect(report.problems).toEqual([]);
    expect(report.unknown).toHaveLength(3);
  });
});

describe('applying the plan', () => {
  it('writes once and then leaves the bucket alone', async () => {
    const { api, puts } = fakeBucket();
    const first = await applyPlan(api, plan);
    expect(first).toMatchObject({ cors: 'applied', lifecycle: 'applied' });
    // R2's default multipart rule is reported as replaced.
    expect(first.replacedLifecycle.map((r) => r.ID)).toEqual(['Default Multipart Abort Rule']);
    const second = await applyPlan(api, plan);
    expect(second).toEqual({ cors: 'unchanged', lifecycle: 'unchanged', replacedLifecycle: [] });
    expect(puts).toEqual({ cors: 1, lifecycle: 1 });
  });

  it('fails when the store does not keep what was written', async () => {
    const { api } = fakeBucket({ ignoreWrites: true });
    await expect(applyPlan(api, plan)).rejects.toThrow(/CORS read back differs/);
  });

  it('fails when the store has no CORS API', async () => {
    const { api } = fakeBucket({ corsSupported: false });
    await expect(applyPlan(api, plan)).rejects.toThrow(/does not support GetBucketCors/);
  });
});

describe('prepareSetup', () => {
  const r2Env = {
    NODE_ENV: 'production',
    APP_STAGE: 'prod',
    PUBLIC_BASE_URL: 'https://photos.example.com',
    ADMIN_BASE_URL: 'https://admin.photos.example.com',
    MEDIA_BUCKET: 'shotx-prod-media',
    STORAGE_ENDPOINT_URL: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY_ID: 'r2-access-key-id',
    STORAGE_SECRET_ACCESS_KEY: 'r2-secret-access-key',
    STORAGE_ORIGINALS_CLASS: 'STANDARD',
    S3_FORCE_PATH_STYLE: 'true',
  };

  it('builds the plan for R2 from the env and cdk.json', () => {
    const setup = prepareSetup(r2Env);
    expect(setup).toMatchObject({ bucket: 'shotx-prod-media', r2: true, local: false });
    expect(setup.plan.cors.flatMap((r) => r.AllowedOrigins)).toEqual([
      'https://photos.example.com',
      'https://photos.example.com',
    ]);
    expect(setup.plan.lifecycle).toHaveLength(4);
  });

  it('refuses the AWS bucket (no STORAGE_ENDPOINT_URL), which belongs to infra/', () => {
    const aws: Record<string, string> = {
      ...r2Env,
      STORAGE_ORIGINALS_CLASS: 'INTELLIGENT_TIERING',
    };
    for (const key of [
      'STORAGE_ENDPOINT_URL',
      'STORAGE_REGION',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
    ]) {
      delete aws[key];
    }
    expect(() => prepareSetup(aws)).toThrow(/managed by infra\//);
  });

  it('refuses unsafe lifecycle rules before any request', () => {
    expect(() => prepareSetup({ ...r2Env, ZIP_RESULT_TTL_SECONDS: String(2 * 86_400) })).toThrow(
      /unsafe \(ADR 0006\)[\s\S]*STORAGE_TMP_ZIPS_EXPIRATION_DAYS/,
    );
  });

  it('reads the lifecycle days from the env', () => {
    const setup = prepareSetup({
      ...r2Env,
      ZIP_RESULT_TTL_SECONDS: String(2 * 86_400),
      STORAGE_TMP_ZIPS_EXPIRATION_DAYS: '3',
    });
    expect(setup.plan.lifecycle.find((r) => r.Filter.Prefix === 'tmp/zips/')?.Expiration).toEqual({
      Days: 3,
    });
    // The shared loader keeps the catch-all at least the per-prefix rules.
    expect(() => prepareSetup({ ...r2Env, STORAGE_TMP_OTHER_EXPIRATION_DAYS: '2' })).toThrow(
      /STORAGE_TMP_OTHER_EXPIRATION_DAYS must be at least/,
    );
  });

  it('works against LocalStack on APP_STAGE=local', () => {
    const setup = prepareSetup({
      APP_STAGE: 'local',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      ADMIN_BASE_URL: 'http://localhost:3001',
      MEDIA_BUCKET: 'shotx-local-media',
      STORAGE_ENDPOINT_URL: 'http://localhost:4566',
      STORAGE_REGION: 'ap-southeast-1',
      STORAGE_ACCESS_KEY_ID: 'test',
      STORAGE_SECRET_ACCESS_KEY: 'test',
      STORAGE_ORIGINALS_CLASS: 'STANDARD',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(setup).toMatchObject({ r2: false, local: true });
    expect(setup.plan.cors[0]?.AllowedOrigins).toEqual(['http://localhost:3000']);
  });
});
