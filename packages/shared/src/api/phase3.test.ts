import { describe, expect, it } from 'vitest';
import {
  ALL_ROUTES,
  apiPath,
  becomePhotographerBodySchema,
  createDownloadBodySchema,
  createDownloadResponseSchema,
  createShareBodySchema,
  decodeOpaqueCursor,
  downloadsHeadersSchema,
  DRIVE_ROUTES,
  encodeOpaqueCursor,
  faceSearchResponseSchema,
  giveConsentBodySchema,
  LATEST_CONSENT_POLICY_VERSION,
  listSharesQuerySchema,
  ME_ROUTES,
  meResponseSchema,
  ownerDownloadQuerySchema,
  PUBLIC_SHARE_ROUTES,
  SHARE_ROUTES,
  shareItemsCursorSchema,
  shareMetaResponseSchema,
  shareStatsQuerySchema,
  shareTokenParamsSchema,
  updateFaceIndexBodySchema,
  updateShareBodySchema,
  uploadInitBodySchema,
  zipJobViewSchema,
} from '../index';

const id = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const token = 'Ab3dEf6hIj9kLm2oPq5sTu';
const now = '2026-10-25T05:12:31.123Z';
const url = 'https://photos.example.com/media/derived/p/f/thumb.webp?Expires=1&Signature=x';

describe('Phase 3 routes', () => {
  it('uses the right auth for each group', () => {
    for (const route of Object.values(SHARE_ROUTES)) expect(route.auth).toBe('photographer');
    for (const route of Object.values(PUBLIC_SHARE_ROUTES)) expect(route.auth).toBe('public');
    expect(ME_ROUTES.get.auth).toBe('user');
    expect(ME_ROUTES.becomePhotographer.auth).toBe('user');
    expect(DRIVE_ROUTES.updateFaceIndex.auth).toBe('photographer');
  });

  it('gives every gated public route the share gate errors', () => {
    for (const route of [
      PUBLIC_SHARE_ROUTES.items,
      PUBLIC_SHARE_ROUTES.faceSearch,
      PUBLIC_SHARE_ROUTES.downloads,
      PUBLIC_SHARE_ROUTES.feedback,
      PUBLIC_SHARE_ROUTES.giveConsent,
      PUBLIC_SHARE_ROUTES.zipJob,
    ]) {
      expect(route.errors).toEqual(
        expect.arrayContaining([
          'NOT_FOUND',
          'SHARE_EXPIRED',
          'LOGIN_REQUIRED',
          'PASSWORD_REQUIRED',
        ]),
      );
    }
    // Withdrawal must always work (PDPA): only the token lookup can fail.
    expect(PUBLIC_SHARE_ROUTES.withdrawConsent.errors).not.toContain('SHARE_EXPIRED');
    expect(PUBLIC_SHARE_ROUTES.withdrawConsent.errors).not.toContain('FEATURE_DISABLED');
    for (const route of [
      PUBLIC_SHARE_ROUTES.faceSearch,
      PUBLIC_SHARE_ROUTES.giveConsent,
      PUBLIC_SHARE_ROUTES.feedback,
      DRIVE_ROUTES.updateFaceIndex,
    ]) {
      expect(route.errors).toContain('FEATURE_DISABLED');
    }
    // Face deletion is a PDPA right: token lookup and consent only (ADR 0007).
    for (const route of [PUBLIC_SHARE_ROUTES.faceDeletion, PUBLIC_SHARE_ROUTES.faceDeletionInfo]) {
      for (const code of [
        'SHARE_EXPIRED',
        'LOGIN_REQUIRED',
        'PASSWORD_REQUIRED',
        'FEATURE_DISABLED',
        'FACE_SEARCH_UNAVAILABLE',
      ]) {
        expect(route.errors).not.toContain(code);
      }
      expect(route.errors).toContain('NOT_FOUND');
    }
    expect(PUBLIC_SHARE_ROUTES.faceDeletion.errors).toContain('CONSENT_REQUIRED');
    expect(PUBLIC_SHARE_ROUTES.faceSearch.errors).toEqual(
      expect.arrayContaining(['CONSENT_REQUIRED', 'NO_FACE_DETECTED', 'FACE_SEARCH_UNAVAILABLE']),
    );
    expect(PUBLIC_SHARE_ROUTES.downloads.errors).toEqual(
      expect.arrayContaining(['DOWNLOAD_NOT_ALLOWED', 'ZIP_TOO_LARGE', 'IDEMPOTENCY_KEY_REUSED']),
    );
  });

  it('takes selfies as multipart parts, never as a JSON body', () => {
    for (const route of [PUBLIC_SHARE_ROUTES.faceSearch, PUBLIC_SHARE_ROUTES.faceDeletion]) {
      expect(route.multipart).toEqual({
        fileField: 'selfie',
        mimeTypes: ['image/jpeg', 'image/png'],
        maxFilesConfigKey: 'FACE_MAX_SELFIES',
      });
      expect('body' in route).toBe(false);
    }
  });

  it('builds share paths', () => {
    expect(apiPath(PUBLIC_SHARE_ROUTES.faceSearch, { token })).toBe(`/api/s/${token}/face-search`);
    expect(apiPath(PUBLIC_SHARE_ROUTES.zipJob, { token, id })).toBe(
      `/api/s/${token}/zip-jobs/${id}`,
    );
    expect(apiPath(SHARE_ROUTES.stats, { id }, { prefix: false })).toBe(`/shares/${id}/stats`);
    // Refs are parsed by the service (NOT_FOUND), never rejected by the params schema (ADR 0011).
    expect(shareTokenParamsSchema.safeParse({ token: 'bangkok-run' }).success).toBe(true);
    expect(shareTokenParamsSchema.safeParse({ token: '' }).success).toBe(false);
  });

  it('has one route per method and path', () => {
    const keys = ALL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('owner share schemas', () => {
  it('fills create defaults', () => {
    expect(createShareBodySchema.parse({ target: { type: 'folder', folderId: id } })).toEqual({
      target: { type: 'folder', folderId: id },
      mode: 'gallery',
      allowDownload: true,
      downloadSize: 'web',
      requireLogin: false,
      password: null,
      expiresAt: null,
    });
  });

  it('allows face_only on folders only, and checks passwords', () => {
    expect(
      createShareBodySchema.safeParse({ target: { type: 'file', fileId: id }, mode: 'face_only' })
        .success,
    ).toBe(false);
    expect(
      createShareBodySchema.safeParse({
        target: { type: 'folder', folderId: id },
        mode: 'face_only',
      }).success,
    ).toBe(true);
    for (const password of ['123', ' 1234', 'x'.repeat(129)]) {
      expect(
        createShareBodySchema.safeParse({ target: { type: 'file', fileId: id }, password }).success,
      ).toBe(false);
    }
    expect(
      createShareBodySchema.safeParse({ target: { type: 'file', fileId: id }, token }).success,
    ).toBe(false);
  });

  it('patches at least one setting and never the token or target', () => {
    expect(updateShareBodySchema.safeParse({}).success).toBe(false);
    expect(updateShareBodySchema.parse({ password: null })).toEqual({ password: null });
    expect(updateShareBodySchema.safeParse({ target: { type: 'file', fileId: id } }).success).toBe(
      false,
    );
    expect(updateShareBodySchema.safeParse({ isActive: true }).success).toBe(false);
  });

  it('validates list and stats queries', () => {
    expect(listSharesQuerySchema.safeParse({ fileId: id, folderId: id }).success).toBe(false);
    expect(listSharesQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    expect(shareStatsQuerySchema.safeParse({ from: '2026-10-25', to: '2026-10-01' }).success).toBe(
      false,
    );
    expect(shareStatsQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-25' }).success).toBe(
      true,
    );
  });
});

describe('drive and upload additions', () => {
  it('enables face indexing without a confirmation (ADR 0011), still accepting the old field', () => {
    expect(updateFaceIndexBodySchema.safeParse({ enabled: true }).success).toBe(true);
    expect(
      updateFaceIndexBodySchema.safeParse({ enabled: true, attendeesInformedConfirmed: true })
        .success,
    ).toBe(true);
    // An old client never sent false; anything but the literal true stays invalid.
    expect(
      updateFaceIndexBodySchema.safeParse({ enabled: true, attendeesInformedConfirmed: false })
        .success,
    ).toBe(false);
    expect(updateFaceIndexBodySchema.safeParse({ enabled: false }).success).toBe(true);
    expect(
      updateFaceIndexBodySchema.safeParse({ enabled: false, attendeesInformedConfirmed: true })
        .success,
    ).toBe(false);
  });

  it('defaults owner downloads to the original', () => {
    expect(ownerDownloadQuerySchema.parse({})).toEqual({ size: 'original' });
  });

  it('takes an optional client upload id for idempotent init', () => {
    const body = { name: 'a.jpg', size: 1, mime: 'image/jpeg', folderId: null };
    expect(uploadInitBodySchema.parse({ ...body, clientUploadId: id }).clientUploadId).toBe(id);
    expect(uploadInitBodySchema.safeParse(body).success).toBe(true);
    expect(uploadInitBodySchema.safeParse({ ...body, clientUploadId: 'abc' }).success).toBe(false);
  });
});

describe('public share schemas', () => {
  const item = {
    id,
    name: 'IMG_0001.JPG',
    mediaKind: 'image',
    width: 6000,
    height: 4000,
    takenAt: now,
    thumbUrl: url,
    previewUrl: url,
    urlsExpireAt: now,
  };

  it('returns share meta with gates as flags', () => {
    const meta = {
      token,
      slug: 'bangkok-run-2026',
      path: '/s/bangkok-run-2026',
      targetType: 'folder',
      mode: 'gallery',
      allowDownload: true,
      downloadSize: 'web',
      requireLogin: false,
      passwordProtected: true,
      expiresAt: null,
      access: { loginRequired: false, locked: true },
      details: null,
      faceSearch: {
        available: false,
        policyVersion: null,
        consented: false,
        maxSelfies: 3,
        selfieLongEdge: 1280,
        selfieJpegQuality: 90,
        resultTtlSeconds: 86_400,
      },
      zip: { maxFiles: 500 },
    };
    expect(shareMetaResponseSchema.parse(meta)).toEqual(meta);
  });

  it('returns face-search groups without scores, face ids or boxes', () => {
    const response = { strong: [item], maybe: [], selfies: 2, selfiesWithoutFace: 1 };
    expect(faceSearchResponseSchema.parse(response)).toEqual(response);
    const leaky = {
      ...response,
      strong: [{ ...item, similarity: 99, faceId: 'x', bbox: { left: 0 } }],
    };
    const parsed = faceSearchResponseSchema.parse(leaky);
    expect(parsed.strong[0]).not.toHaveProperty('similarity');
    expect(parsed.strong[0]).not.toHaveProperty('faceId');
    expect(parsed.strong[0]).not.toHaveProperty('bbox');
  });

  it('accepts any well-formed version, so the service can answer CONSENT_VERSION_MISMATCH', () => {
    expect(
      giveConsentBodySchema.parse({ policyVersion: LATEST_CONSENT_POLICY_VERSION, accepted: true }),
    ).toEqual({
      purpose: 'face_search',
      policyVersion: LATEST_CONSENT_POLICY_VERSION,
      locale: 'th',
      accepted: true,
    });
    expect(
      giveConsentBodySchema.safeParse({
        policyVersion: LATEST_CONSENT_POLICY_VERSION,
        accepted: false,
      }).success,
    ).toBe(false);
    // Outdated or unknown but well-formed: reaches the service (409, not 400).
    for (const policyVersion of ['v0', '2025-01-01', 'draft.2']) {
      expect(giveConsentBodySchema.safeParse({ policyVersion, accepted: true }).success).toBe(true);
    }
    for (const policyVersion of ['', '-x', 'has space', 'x'.repeat(33), '../etc']) {
      expect(giveConsentBodySchema.safeParse({ policyVersion, accepted: true }).success).toBe(
        false,
      );
    }
    expect(
      giveConsentBodySchema.parse({
        purpose: 'face_deletion',
        policyVersion: LATEST_CONSENT_POLICY_VERSION,
        accepted: true,
      }).purpose,
    ).toBe('face_deletion');
    expect(
      giveConsentBodySchema.safeParse({
        purpose: 'marketing',
        policyVersion: LATEST_CONSENT_POLICY_VERSION,
        accepted: true,
      }).success,
    ).toBe(false);
  });

  it('validates downloads', () => {
    expect(createDownloadBodySchema.safeParse({ fileIds: [] }).success).toBe(false);
    expect(createDownloadBodySchema.safeParse({ fileIds: [id, id] }).success).toBe(false);
    expect(downloadsHeadersSchema.parse({ 'idempotency-key': 'k-1', other: 'x' })).toEqual({
      'idempotency-key': 'k-1',
    });
    expect(downloadsHeadersSchema.safeParse({ 'idempotency-key': 'has space' }).success).toBe(
      false,
    );
    const job = {
      id,
      status: 'queued',
      fileCount: 2,
      totalBytes: 10,
      createdAt: now,
      download: null,
      availableUntil: null,
      errorCode: null,
    };
    expect(zipJobViewSchema.parse({ ...job, status: 'expired' }).status).toBe('expired');
    expect(createDownloadResponseSchema.parse({ kind: 'zip', job })).toEqual({ kind: 'zip', job });
    const file = { fileId: id, url, fileName: 'IMG_0001.jpg', expiresAt: now };
    expect(createDownloadResponseSchema.parse({ kind: 'file', file })).toEqual({
      kind: 'file',
      file,
    });
  });

  it('round-trips item cursors and refuses forged ones', () => {
    const cursor = { v: 1 as const, shareId: id, key: '2026-10-25 12:12:31.123456+07', id };
    const text = encodeOpaqueCursor(shareItemsCursorSchema, cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeOpaqueCursor(shareItemsCursorSchema, text)).toEqual(cursor);
    expect(decodeOpaqueCursor(shareItemsCursorSchema, 'AAAA')).toBeNull();
    expect(decodeOpaqueCursor(shareItemsCursorSchema, '')).toBeNull();
  });
});

describe('me', () => {
  it('describes viewers and photographers', () => {
    const me = {
      id,
      role: 'photographer',
      email: null,
      name: 'ช่างภาพ',
      createdAt: now,
      subscription: {
        status: 'trial',
        planCode: 'trial',
        periodEnd: now,
        cancelAtPeriodEnd: false,
      },
      features: { faceSearch: false },
      passwordChangeRequired: false,
    };
    expect(meResponseSchema.parse(me)).toEqual(me);
    expect(
      meResponseSchema.parse({ ...me, passwordChangeRequired: true }).passwordChangeRequired,
    ).toBe(true);
    expect(meResponseSchema.safeParse({ ...me, passwordChangeRequired: undefined }).success).toBe(
      false,
    );
    expect(meResponseSchema.safeParse({ ...me, role: 'admin' }).success).toBe(false);
    expect(becomePhotographerBodySchema.parse({})).toEqual({});
    expect(becomePhotographerBodySchema.parse({ name: '  สตูดิโอ ' })).toEqual({ name: 'สตูดิโอ' });
  });
});
