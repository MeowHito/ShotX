import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { S3_PREFIXES } from '../s3-keys';
import {
  ABORT_INCOMPLETE_MULTIPART_MIN_DAYS,
  loadStorageLifecycleConfig,
  minReconcileExpirationDays,
  minZipExpirationDays,
  STORAGE_LIFECYCLE_DEFAULTS,
  STORAGE_LIFECYCLE_ENV,
  zipObjectLifetime,
} from './lifecycle';
import { loadShareConfig } from './share';
import { loadWorkerSettings } from './worker';

describe('loadStorageLifecycleConfig', () => {
  it('defaults to STORAGE_LIFECYCLE_DEFAULTS', () => {
    expect(loadStorageLifecycleConfig({})).toEqual(STORAGE_LIFECYCLE_DEFAULTS);
  });

  it('reads overrides', () => {
    expect(
      loadStorageLifecycleConfig({
        STORAGE_TMP_ZIPS_EXPIRATION_DAYS: '3',
        STORAGE_UPLOAD_CORS_MAX_AGE_SECONDS: '600',
        STORAGE_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS: '7',
      }),
    ).toMatchObject({
      tmpZipsExpirationDays: 3,
      uploadCorsMaxAgeSeconds: 600,
      abortIncompleteMultipartUploadDays: 7,
    });
  });

  it('keeps every tmp/ rule within 1-3 days and the catch-all at least as long as the others', () => {
    for (const key of [
      STORAGE_LIFECYCLE_ENV.tmpZipsExpirationDays,
      STORAGE_LIFECYCLE_ENV.tmpReconcileExpirationDays,
      STORAGE_LIFECYCLE_ENV.tmpOtherExpirationDays,
    ]) {
      expect(() => loadStorageLifecycleConfig({ [key]: '4' }), key).toThrow(new RegExp(key));
      expect(() => loadStorageLifecycleConfig({ [key]: '0' }), key).toThrow(new RegExp(key));
    }
    expect(() => loadStorageLifecycleConfig({ STORAGE_TMP_OTHER_EXPIRATION_DAYS: '2' })).toThrow(
      /STORAGE_TMP_OTHER_EXPIRATION_DAYS must be at least/,
    );
  });

  it('never aborts multipart uploads before a session can end', () => {
    expect(ABORT_INCOMPLETE_MULTIPART_MIN_DAYS).toBe(2);
    expect(() =>
      loadStorageLifecycleConfig({ STORAGE_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS: '1' }),
    ).toThrow(/STORAGE_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS/);
  });
});

describe('ADR 0006 lifecycle helpers', () => {
  it('needs the zip rule to outlive processing + result TTL + URL lifetime', () => {
    // Defaults: 7200 + 86400 + 600 + 300 = 94500 s, 2 days.
    const lifetime = zipObjectLifetime(loadWorkerSettings({}), [loadShareConfig({})]);
    expect(lifetime).toEqual({
      maxProcessingSeconds: 7200,
      resultTtlSeconds: 86_400,
      downloadTtlSeconds: 600,
      expiryBucketSeconds: 300,
      seconds: 94_500,
    });
    expect(minZipExpirationDays(lifetime)).toBe(2);
    expect(STORAGE_LIFECYCLE_DEFAULTS.tmpZipsExpirationDays).toBeGreaterThanOrEqual(2);
  });

  it('takes the largest of several share configs', () => {
    const shares = [
      loadShareConfig({}),
      loadShareConfig({ ZIP_RESULT_TTL_SECONDS: String(2 * 86_400) }),
    ];
    const lifetime = zipObjectLifetime(loadWorkerSettings({}), shares);
    expect(lifetime.resultTtlSeconds).toBe(2 * 86_400);
    expect(minZipExpirationDays(lifetime)).toBe(3);
    expect(() => zipObjectLifetime(loadWorkerSettings({}), [])).toThrow(RangeError);
  });

  it('needs reconcile scans to survive one grace period plus one daily run', () => {
    expect(minReconcileExpirationDays(3 * 3_600_000)).toBe(2);
    expect(minReconcileExpirationDays(86_400_000)).toBe(2);
    expect(minReconcileExpirationDays(86_400_001)).toBe(3);
    expect(STORAGE_LIFECYCLE_DEFAULTS.tmpReconcileExpirationDays).toBeGreaterThanOrEqual(2);
  });

  it('has the tmp/reconcile/ prefix under tmp/', () => {
    expect(S3_PREFIXES.tmpReconcile).toBe('tmp/reconcile/');
    expect(S3_PREFIXES.tmpReconcile.startsWith(S3_PREFIXES.tmp)).toBe(true);
  });
});

const CDK_JSON = new URL('../../../../infra/cdk.json', import.meta.url);

// infra/ is removed after the VPS stack runs (ADR 0008); then the shared defaults stand alone.
describe.skipIf(!existsSync(CDK_JSON))(
  'lifecycle defaults match infra/cdk.json while infra/ exists',
  () => {
    it('has the same values as context.shotx.storage', () => {
      const storage = (
        JSON.parse(readFileSync(CDK_JSON, 'utf8')) as {
          context: { shotx: { storage: Record<string, unknown> } };
        }
      ).context.shotx.storage;
      for (const [key, value] of Object.entries(STORAGE_LIFECYCLE_DEFAULTS)) {
        expect(storage[key], key).toBe(value);
      }
    });
  },
);
