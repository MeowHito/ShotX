import { readFileSync } from 'node:fs';
import {
  loadFaceConfig,
  loadShareConfig,
  loadWorkerSettings,
  S3_PREFIXES,
  TMP_LIFECYCLE_MAX_DAYS,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCorsRules,
  buildLifecycleRules,
  canonicalCors,
  describeLifecycle,
  lifecycleIssues,
  mainOrigin,
  minReconcileExpirationDays,
  minZipExpirationDays,
  type RuntimeSettings,
  sameCors,
  sameLifecycle,
  type StorageSettings,
  storageSettingsFromCdkJson,
  TMP_RECONCILE_PREFIX,
  zipObjectLifetime,
} from '../r2/rules';

const cdkJson: unknown = JSON.parse(
  readFileSync(new URL('../../infra/cdk.json', import.meta.url), 'utf8'),
);
const withStorage = (edit: Record<string, unknown>) => {
  const c = structuredClone(cdkJson) as { context: { shotx: { storage: object } } };
  c.context.shotx.storage = { ...c.context.shotx.storage, ...edit };
  return c;
};
const settings = storageSettingsFromCdkJson(cdkJson);
const runtime = (env: Record<string, string> = {}): RuntimeSettings => ({
  worker: loadWorkerSettings(env),
  shares: [loadShareConfig(env)],
  face: loadFaceConfig(env),
});

describe('storage settings from infra/cdk.json', () => {
  it('reads the values infra uses for the AWS bucket', () => {
    expect(settings).toEqual({
      abortIncompleteMultipartUploadDays: 2,
      tmpZipsExpirationDays: 2,
      tmpReconcileExpirationDays: 3,
      tmpOtherExpirationDays: 3,
      uploadCorsMaxAgeSeconds: 3000,
    });
  });

  it('keeps every tmp/ rule within ADR 0006 range', () => {
    for (const key of [
      'tmpZipsExpirationDays',
      'tmpReconcileExpirationDays',
      'tmpOtherExpirationDays',
    ]) {
      expect(
        () => storageSettingsFromCdkJson(withStorage({ [key]: TMP_LIFECYCLE_MAX_DAYS + 1 })),
        key,
      ).toThrow(new RegExp(key));
      expect(() => storageSettingsFromCdkJson(withStorage({ [key]: 0 })), key).toThrow(
        new RegExp(key),
      );
    }
    expect(() =>
      storageSettingsFromCdkJson(withStorage({ abortIncompleteMultipartUploadDays: 8 })),
    ).toThrow(/abortIncompleteMultipartUploadDays/);
  });

  it('refuses a file without context.shotx.storage', () => {
    expect(() => storageSettingsFromCdkJson({ context: {} })).toThrow();
  });
});

describe('ADR 0006 checks', () => {
  it('passes with cdk.json and the shared defaults', () => {
    expect(lifecycleIssues(settings, runtime())).toEqual([]);
  });

  it('needs the zip rule to outlive processing + result TTL + URL lifetime', () => {
    // Defaults: 7200 + 86400 + 600 + 300 = 94500 s, 2 days.
    const lifetime = zipObjectLifetime(runtime().worker, runtime().shares);
    expect(lifetime.seconds).toBe(94_500);
    expect(minZipExpirationDays(lifetime)).toBe(2);
    const short: StorageSettings = { ...settings, tmpZipsExpirationDays: 1 };
    expect(lifecycleIssues(short, runtime()).join('\n')).toMatch(
      /tmpZipsExpirationDays \(1\) must be >= 2: [\s\S]*= 94500s/,
    );
    // A two-day result TTL needs three days.
    const long = runtime({ ZIP_RESULT_TTL_SECONDS: String(2 * 86_400) });
    expect(lifecycleIssues(settings, long).join('\n')).toMatch(
      /tmpZipsExpirationDays \(2\) must be >= 3/,
    );
    expect(lifecycleIssues({ ...settings, tmpZipsExpirationDays: 3 }, long)).toEqual([]);
  });

  it('takes the largest value when api and worker env differ', () => {
    const shares = [
      loadShareConfig({}),
      loadShareConfig({ ZIP_RESULT_TTL_SECONDS: String(2 * 86_400) }),
    ];
    expect(zipObjectLifetime(loadWorkerSettings({}), shares).resultTtlSeconds).toBe(2 * 86_400);
  });

  it('needs reconcile scans to survive one grace period plus one daily run', () => {
    expect(minReconcileExpirationDays(3 * 3_600_000)).toBe(2);
    expect(minReconcileExpirationDays(86_400_000)).toBe(2);
    const issues = lifecycleIssues({ ...settings, tmpReconcileExpirationDays: 1 }, runtime());
    expect(issues.join('\n')).toMatch(/tmpReconcileExpirationDays \(1\) must be >= 2/);
  });

  it('keeps the tmp/ catch-all at least as long as every per-prefix rule', () => {
    const issues = lifecycleIssues({ ...settings, tmpOtherExpirationDays: 2 }, runtime());
    expect(issues.join('\n')).toMatch(/tmpOtherExpirationDays \(2\) must be >= 3/);
  });
});

describe('CORS rules', () => {
  it('allows PUT with ETag and GET/HEAD from the main origin only', () => {
    expect(buildCorsRules('https://photos.example.com', 3000)).toEqual([
      {
        ID: 'upload-parts',
        AllowedOrigins: ['https://photos.example.com'],
        AllowedMethods: ['PUT'],
        AllowedHeaders: ['content-type'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3000,
      },
      {
        ID: 'share-downloads',
        AllowedOrigins: ['https://photos.example.com'],
        AllowedMethods: ['GET', 'HEAD'],
        MaxAgeSeconds: 3000,
      },
    ]);
  });

  it('never allows a wildcard or a malformed origin', () => {
    for (const origin of ['*', 'null', 'https://photos.example.com/']) {
      expect(() => buildCorsRules(origin, 0), origin).toThrow(/one exact origin/);
    }
  });

  it('uses the origin of PUBLIC_BASE_URL', () => {
    expect(mainOrigin('https://photos.example.com/th/studio')).toBe('https://photos.example.com');
    expect(mainOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(() => mainOrigin('ftp://photos.example.com')).toThrow(/http\(s\)/);
  });

  it('compares rules regardless of ids, order and header case', () => {
    const rules = buildCorsRules('https://photos.example.com', 3000);
    const readBack = [...rules].reverse().map(({ ID: _id, ...r }) => ({
      ...r,
      AllowedHeaders: r.AllowedHeaders?.map((h) => h.toUpperCase()),
      ExposeHeaders: r.ExposeHeaders?.map((h) => h.toLowerCase()),
    }));
    expect(sameCors(readBack, rules)).toBe(true);
    expect(sameCors(buildCorsRules('https://photos.example.com', 60), rules)).toBe(false);
    expect(sameCors(buildCorsRules('https://other.example.com', 3000), rules)).toBe(false);
    expect(canonicalCors([])).toEqual([]);
  });
});

describe('lifecycle rules', () => {
  const rules = buildLifecycleRules(settings);

  it('aborts multipart uploads bucket-wide and expires each tmp/ prefix', () => {
    expect(rules).toEqual([
      {
        ID: 'abort-incomplete-multipart-uploads',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
      },
      {
        ID: 'expire-tmp-zips',
        Status: 'Enabled',
        Filter: { Prefix: 'tmp/zips/' },
        Expiration: { Days: 2 },
      },
      {
        ID: 'expire-tmp-reconcile',
        Status: 'Enabled',
        Filter: { Prefix: 'tmp/reconcile/' },
        Expiration: { Days: 3 },
      },
      {
        ID: 'expire-tmp-other',
        Status: 'Enabled',
        Filter: { Prefix: 'tmp/' },
        Expiration: { Days: 3 },
      },
    ]);
    expect(TMP_RECONCILE_PREFIX).toBe(`${S3_PREFIXES.tmp}reconcile/`);
  });

  it('has no tmp/index/ rule and no storage-class transition (R2)', () => {
    expect(rules.map((r) => r.Filter.Prefix)).not.toContain(S3_PREFIXES.tmpIndex);
    expect(JSON.stringify(rules)).not.toMatch(/Transition|INTELLIGENT_TIERING/);
  });

  it('never expires anything outside tmp/', () => {
    for (const r of rules.filter((x) => x.Expiration !== undefined)) {
      expect(r.Filter.Prefix.startsWith(S3_PREFIXES.tmp), r.ID).toBe(true);
    }
  });

  it('compares with what a store returns (legacy Prefix, other ids)', () => {
    const readBack = rules.map(({ ID: _id, Filter, ...r }, i) =>
      i === 0 ? { ...r, ID: 'x', Prefix: Filter.Prefix } : { ...r, Filter },
    );
    expect(sameLifecycle(readBack, rules)).toBe(true);
    expect(sameLifecycle(rules.slice(1), rules)).toBe(false);
    const r2Default = {
      ID: 'Default Multipart Abort Rule',
      Status: 'Enabled',
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    };
    expect(sameLifecycle([r2Default], rules)).toBe(false);
  });

  it('describes R2 deleting up to a day late', () => {
    expect(describeLifecycle(settings).join('\n')).toMatch(
      /tmp\/zips\/: 2 day\(s\), deleted by R2 up to ~1 day late/,
    );
  });
});
