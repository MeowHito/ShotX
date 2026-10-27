import {
  loadFaceConfig,
  loadShareConfig,
  loadStorageLifecycleConfig,
  loadWorkerSettings,
  S3_PREFIXES,
  STORAGE_LIFECYCLE_DEFAULTS,
  type StorageLifecycleConfig,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCorsRules,
  buildLifecycleRules,
  canonicalCors,
  describeLifecycle,
  lifecycleIssues,
  mainOrigin,
  type RuntimeSettings,
  sameCors,
  sameLifecycle,
} from '../r2/rules';

// The lifecycle settings and the ADR 0006 math are tested in packages/shared
// (config/lifecycle.test.ts); these tests cover what deploy/ builds from them.

const settings: StorageLifecycleConfig = loadStorageLifecycleConfig({});
const runtime = (env: Record<string, string> = {}): RuntimeSettings => ({
  worker: loadWorkerSettings(env),
  shares: [loadShareConfig(env)],
  face: loadFaceConfig(env),
});

describe('lifecycle settings', () => {
  it('default to the values the AWS bucket uses', () => {
    expect(settings).toEqual(STORAGE_LIFECYCLE_DEFAULTS);
  });
});

describe('ADR 0006 checks', () => {
  it('passes with the shared defaults', () => {
    expect(lifecycleIssues(settings, runtime())).toEqual([]);
  });

  it('needs the zip rule to outlive processing + result TTL + URL lifetime', () => {
    // Defaults: 7200 + 86400 + 600 + 300 = 94500 s, 2 days.
    const short: StorageLifecycleConfig = { ...settings, tmpZipsExpirationDays: 1 };
    expect(lifecycleIssues(short, runtime()).join('\n')).toMatch(
      /STORAGE_TMP_ZIPS_EXPIRATION_DAYS \(1\) must be >= 2: [\s\S]*= 94500s/,
    );
    // A two-day result TTL needs three days.
    const long = runtime({ ZIP_RESULT_TTL_SECONDS: String(2 * 86_400) });
    expect(lifecycleIssues(settings, long).join('\n')).toMatch(
      /STORAGE_TMP_ZIPS_EXPIRATION_DAYS \(2\) must be >= 3/,
    );
    expect(lifecycleIssues({ ...settings, tmpZipsExpirationDays: 3 }, long)).toEqual([]);
  });

  it('takes the largest value when api and worker env differ', () => {
    const shares = [
      loadShareConfig({}),
      loadShareConfig({ ZIP_RESULT_TTL_SECONDS: String(2 * 86_400) }),
    ];
    expect(lifecycleIssues(settings, { ...runtime(), shares }).join('\n')).toMatch(
      /STORAGE_TMP_ZIPS_EXPIRATION_DAYS \(2\) must be >= 3/,
    );
  });

  it('needs reconcile scans to survive one grace period plus one daily run', () => {
    const issues = lifecycleIssues({ ...settings, tmpReconcileExpirationDays: 1 }, runtime());
    expect(issues.join('\n')).toMatch(/STORAGE_TMP_RECONCILE_EXPIRATION_DAYS \(1\) must be >= 2/);
  });

  it('keeps the tmp/ catch-all at least as long as every per-prefix rule', () => {
    const issues = lifecycleIssues({ ...settings, tmpOtherExpirationDays: 2 }, runtime());
    expect(issues.join('\n')).toMatch(/STORAGE_TMP_OTHER_EXPIRATION_DAYS \(2\) must be >= 3/);
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
  });

  it('has no tmp/index/ rule and no storage-class transition (R2)', () => {
    expect(rules.map((r) => r.Filter.Prefix)).not.toContain('tmp/index/');
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
