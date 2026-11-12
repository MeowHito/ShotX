import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES,
  ARGON2ID_PARAM_BOUNDS,
  argon2idParamsAcceptable,
  CONSENT_PURPOSE_GATES,
  CONSENT_PURPOSES,
  consentGates,
  consentPolicyVersionSchema,
  consentResponseSchema,
  faceDeletionAlertDue,
  faceDeletionInfoResponseSchema,
  loadFaceConfig,
  loadShareConfig,
  loadSharePasswordHashConfig,
  owaspArgon2idMinMemoryKiB,
  PUBLIC_SHARE_ROUTE_ACTIVITY,
  PUBLIC_SHARE_ROUTES,
  publicShareRouteWritesActivity,
  shareZipJobParamsSchema,
  TMP_LIFECYCLE_MAX_DAYS,
  WORKER_MAX_PROCESSING_SECONDS_LIMIT,
  ZIP_OBJECT_MAX_AGE_SECONDS,
  ZIP_RESULT_TTL_MAX_SECONDS,
} from '../index';

const id = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const token = 'Ab3dEf6hIj9kLm2oPq5sTu';
const DAY = 86_400;

describe('consent purposes (Phase 3 review, ADR 0007)', () => {
  it('gates face search fully and face deletion on the token only', () => {
    expect(CONSENT_PURPOSES).toEqual(['face_search', 'face_deletion']);
    expect(consentGates('face_search')).toEqual({
      availability: true,
      access: true,
      featureFlag: true,
    });
    expect(consentGates('face_deletion')).toEqual({
      availability: false,
      access: false,
      featureFlag: false,
    });
    expect(Object.keys(CONSENT_PURPOSE_GATES).sort()).toEqual([...CONSENT_PURPOSES].sort());
  });

  it('returns the purpose with the consent', () => {
    const consent = {
      purpose: 'face_deletion',
      policyVersion: '2026-10-25',
      locale: 'th',
      acceptedAt: '2026-10-26T01:00:00.000Z',
    };
    expect(consentResponseSchema.parse(consent)).toEqual(consent);
  });

  it('describes the deletion page without share gates', () => {
    const info = {
      policyVersion: '2026-10-25',
      consented: false,
      maxSelfies: 3,
      selfieLongEdge: 1280,
      selfieJpegQuality: 90,
    };
    expect(faceDeletionInfoResponseSchema.parse(info)).toEqual(info);
    expect(PUBLIC_SHARE_ROUTES.faceDeletionInfo.errors).not.toContain('SHARE_EXPIRED');
  });

  it('accepts well-formed version strings only', () => {
    expect(consentPolicyVersionSchema.safeParse('2026-10-25').success).toBe(true);
    expect(consentPolicyVersionSchema.safeParse('v2_draft.1').success).toBe(true);
    expect(consentPolicyVersionSchema.safeParse('.hidden').success).toBe(false);
    expect(consentPolicyVersionSchema.safeParse('2026/10/25').success).toBe(false);
  });
});

describe('zip jobs under the share path', () => {
  it('needs the token and the job id', () => {
    expect(PUBLIC_SHARE_ROUTES.zipJob.path).toBe('/s/:token/zip-jobs/:id');
    expect(shareZipJobParamsSchema.parse({ token, id })).toEqual({ token, id });
    expect(shareZipJobParamsSchema.safeParse({ id }).success).toBe(false);
    expect(PUBLIC_SHARE_ROUTES.zipJob.errors).toEqual(
      expect.arrayContaining(['SHARE_EXPIRED', 'LOGIN_REQUIRED', 'PASSWORD_REQUIRED']),
    );
  });
});

describe('activity events per public share route', () => {
  it('covers every route and never writes from the meta route', () => {
    expect(Object.keys(PUBLIC_SHARE_ROUTE_ACTIVITY).sort()).toEqual(
      Object.keys(PUBLIC_SHARE_ROUTES).sort(),
    );
    for (const type of ACTIVITY_TYPES) {
      expect(publicShareRouteWritesActivity('meta', type)).toBe(false);
    }
    expect(publicShareRouteWritesActivity('items', 'view')).toBe(true);
    expect(publicShareRouteWritesActivity('faceSearch', 'scan')).toBe(true);
    expect(publicShareRouteWritesActivity('faceDeletion', 'scan')).toBe(false);
    expect(publicShareRouteWritesActivity('zipJob', 'zip')).toBe(true);
    expect(publicShareRouteWritesActivity('downloads', 'zip')).toBe(false);
  });
});

describe('zip result TTL ceiling', () => {
  it('fits the 3-day tmp/ lifecycle with the worst processing cap', () => {
    expect(TMP_LIFECYCLE_MAX_DAYS).toBe(3);
    expect(ZIP_RESULT_TTL_MAX_SECONDS).toBe(2 * DAY);
    expect(ZIP_OBJECT_MAX_AGE_SECONDS).toBe(3 * DAY);
    const share = loadShareConfig({});
    // The defaults need 94,500 s with a 2 h zip cap: inside a 2-day tmp/zips/ rule.
    expect(
      2 * 3600 +
        share.zip.resultTtlSeconds +
        share.signedUrlTtlSeconds.download +
        share.signedUrlExpiryBucketSeconds,
    ).toBe(94_500);
  });

  it('accepts the maximum TTL with default URL lifetimes, and rejects what overflows', () => {
    expect(
      loadShareConfig({ ZIP_RESULT_TTL_SECONDS: String(ZIP_RESULT_TTL_MAX_SECONDS) }).zip
        .resultTtlSeconds,
    ).toBe(2 * DAY);
    expect(() =>
      loadShareConfig({ ZIP_RESULT_TTL_SECONDS: String(ZIP_RESULT_TTL_MAX_SECONDS + 1) }),
    ).toThrow(/ZIP_RESULT_TTL_SECONDS/);
    // Room left at the maximum TTL: 3 d - 2 d - 11 h = 13 h for the download URL and bucket.
    const room = ZIP_OBJECT_MAX_AGE_SECONDS - ZIP_RESULT_TTL_MAX_SECONDS;
    expect(room - WORKER_MAX_PROCESSING_SECONDS_LIMIT).toBe(13 * 3600);
    expect(() =>
      loadShareConfig({
        ZIP_RESULT_TTL_SECONDS: String(ZIP_RESULT_TTL_MAX_SECONDS),
        SIGNED_URL_VIEW_TTL_SECONDS: String(DAY),
        SIGNED_URL_DOWNLOAD_TTL_SECONDS: String(13 * 3600),
      }),
    ).toThrow(/tmp\/ lifecycle ceiling/);
  });
});

describe('share password hashing (argon2id)', () => {
  it("defaults to OWASP's 19 MiB, 2 passes, 1 lane", () => {
    expect(loadSharePasswordHashConfig({})).toEqual({
      argon2id: { memoryKiB: 19_456, timeCost: 2, parallelism: 1 },
    });
  });

  it("enforces OWASP's minimum memory for the time cost", () => {
    expect(owaspArgon2idMinMemoryKiB(1)).toBe(47_104);
    expect(owaspArgon2idMinMemoryKiB(3)).toBe(12_288);
    expect(owaspArgon2idMinMemoryKiB(9)).toBe(7_168);
    expect(
      loadSharePasswordHashConfig({
        SHARE_PASSWORD_ARGON2_MEMORY_KIB: '47104',
        SHARE_PASSWORD_ARGON2_TIME_COST: '1',
      }).argon2id,
    ).toEqual({ memoryKiB: 47_104, timeCost: 1, parallelism: 1 });
    expect(() =>
      loadSharePasswordHashConfig({
        SHARE_PASSWORD_ARGON2_MEMORY_KIB: '19456',
        SHARE_PASSWORD_ARGON2_TIME_COST: '1',
      }),
    ).toThrow(/OWASP/);
    expect(() => loadSharePasswordHashConfig({ SHARE_PASSWORD_ARGON2_MEMORY_KIB: '4096' })).toThrow(
      /SHARE_PASSWORD_ARGON2_MEMORY_KIB/,
    );
    expect(() => loadSharePasswordHashConfig({ SHARE_PASSWORD_ARGON2_PARALLELISM: '9' })).toThrow(
      /SHARE_PASSWORD_ARGON2_PARALLELISM/,
    );
  });

  it('bounds what a stored hash may ask for', () => {
    expect(argon2idParamsAcceptable({ memoryKiB: 19_456, timeCost: 2, parallelism: 1 })).toBe(true);
    expect(
      argon2idParamsAcceptable({
        memoryKiB: ARGON2ID_PARAM_BOUNDS.memoryKiB.max + 1,
        timeCost: 2,
        parallelism: 1,
      }),
    ).toBe(false);
    expect(argon2idParamsAcceptable({ memoryKiB: 7_168, timeCost: 4, parallelism: 1 })).toBe(false);
  });
});

describe('face deletion alert', () => {
  it('fires at the per-share threshold', () => {
    const { alert } = loadFaceConfig({ FACE_DELETION_ALERT_PER_SHARE: '3' }).deletion;
    expect(faceDeletionAlertDue(2, alert)).toBe(false);
    expect(faceDeletionAlertDue(3, alert)).toBe(true);
  });
});
