import { describe, expect, it } from 'vitest';
import { ERROR_DETAILS_SCHEMAS, ERROR_HTTP_STATUS, ErrorCode } from '../errors';
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_COOKIE,
  localeFromCookie,
  SUPPORTED_LOCALES,
} from '../locale';
import { FACE_INDEX_EXPIRY_DAYS_DEFAULT, loadRetentionConfig } from '../config/retention';
import {
  adminChangePasswordResponseSchema,
  adminLoginResponseSchema,
  ADMIN_SIGN_IN_STEPS_BY_MODE,
} from './auth';
import { driveFolderSchema, updateFaceIndexBodySchema, updateFolderBodySchema } from './drive';
import { DRIVE_ROUTES, PUBLIC_SHARE_ROUTES } from './routes';
import {
  consentResponseSchema,
  createDownloadBodySchema,
  giveConsentBodySchema,
  shareItemSchema,
  shareMetaResponseSchema,
  shareZipJobParamsSchema,
} from './share-page';
import { ownerShareSchema } from './shares';

// Contracts of ADR 0011 (event gallery redesign) and its decision 4 (admin MFA mode).

const id = '0193a5b0-7c1e-7cc3-9b1e-2f3a4b5c6d7e';
const token = 'AbCdEfGhIjKlMnOpQrStUv';
const at = '2026-11-12T01:00:00.000Z';

describe('locales', () => {
  it('lists th, en and zh with Thai as the default', () => {
    expect(SUPPORTED_LOCALES).toEqual(['th', 'en', 'zh']);
    expect(DEFAULT_LOCALE).toBe('th');
    expect(LOCALE_COOKIE).toBe('shotx_locale');
  });

  it('reads the cookie, falling back to Thai', () => {
    expect(localeFromCookie('zh')).toBe('zh');
    expect(localeFromCookie('en')).toBe('en');
    for (const value of [undefined, null, '', 'EN', 'ja', 'th-TH']) {
      expect(localeFromCookie(value)).toBe('th');
    }
    expect(isSupportedLocale('th')).toBe(true);
    expect(isSupportedLocale(1)).toBe(false);
  });
});

describe('consent locale', () => {
  it('defaults to th for older clients and records the language shown', () => {
    const body = { policyVersion: '2026-11-11b', accepted: true };
    expect(giveConsentBodySchema.parse(body).locale).toBe('th');
    expect(giveConsentBodySchema.parse({ ...body, locale: 'zh' }).locale).toBe('zh');
    expect(giveConsentBodySchema.safeParse({ ...body, locale: 'ja' }).success).toBe(false);
    const consent = {
      purpose: 'face_search',
      policyVersion: '2026-11-11b',
      locale: 'en',
      acceptedAt: at,
    };
    expect(consentResponseSchema.parse(consent)).toEqual(consent);
    expect(consentResponseSchema.safeParse({ ...consent, locale: undefined }).success).toBe(false);
  });
});

describe('share slugs in responses', () => {
  const owner = {
    id,
    token,
    slug: 'bangkok-run-2026',
    path: '/s/bangkok-run-2026',
    url: 'https://snap.example.com/s/bangkok-run-2026',
    target: { type: 'folder', id, name: 'Bangkok Run 2026', unavailable: false },
    mode: 'gallery',
    allowDownload: true,
    downloadSize: 'web',
    requireLogin: false,
    passwordProtected: false,
    expiresAt: null,
    designId: null,
    status: 'active',
    createdAt: at,
  };

  it('gives owners the slug, the public path and the slug URL', () => {
    expect(ownerShareSchema.parse(owner)).toEqual(owner);
    expect(ownerShareSchema.parse({ ...owner, slug: null, path: `/s/${token}` }).slug).toBeNull();
    expect(ownerShareSchema.safeParse({ ...owner, slug: 'Bangkok Run' }).success).toBe(false);
    expect(ownerShareSchema.safeParse({ ...owner, path: undefined }).success).toBe(false);
  });

  it('takes a ref in every public share route and never validates its format there', () => {
    expect(PUBLIC_SHARE_ROUTES.meta.path).toBe('/s/:token');
    for (const route of Object.values(PUBLIC_SHARE_ROUTES)) {
      expect(route.params.safeParse({ token: 'งานวิ่ง-2026', id }).success, route.path).toBe(true);
      expect(route.params.safeParse({ token, id }).success, route.path).toBe(true);
    }
    expect(shareZipJobParamsSchema.safeParse({ token: 'bangkok-run', id }).success).toBe(true);
  });
});

describe('share items', () => {
  it('carry width and height for the masonry grid', () => {
    const shape = shareItemSchema.shape;
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['width', 'height']));
    const item = {
      id,
      name: 'a.jpg',
      mediaKind: 'image',
      width: 4000,
      height: 6000,
      takenAt: null,
      thumbUrl: 'https://media.example.com/t',
      previewUrl: 'https://media.example.com/p',
      urlsExpireAt: at,
    };
    expect(shareItemSchema.parse(item)).toMatchObject({ width: 4000, height: 6000 });
  });
});

describe('share meta', () => {
  it('requires the slug and path; the cover keeps its preview fields', () => {
    const shape = shareMetaResponseSchema.shape;
    expect(shape.slug.safeParse(null).success).toBe(true);
    expect(shape.slug.safeParse('bangkok-run').success).toBe(true);
    expect(shape.path.safeParse('/s/bangkok-run').success).toBe(true);
    expect(shape.path.safeParse('bangkok-run').success).toBe(false);
    expect(
      shape.details.safeParse({
        title: 'Run',
        photographerName: null,
        itemCount: null,
        cover: { previewUrl: 'https://media.example.com/p', width: 1600, height: 300 },
      }).success,
    ).toBe(true);
  });
});

describe('selection downloads', () => {
  it('reuses POST /s/:token/downloads for selected or all found photos', () => {
    expect(PUBLIC_SHARE_ROUTES.downloads.path).toBe('/s/:token/downloads');
    expect(createDownloadBodySchema.safeParse({ fileIds: [id] }).success).toBe(true);
    expect(createDownloadBodySchema.safeParse({ fileIds: [id, id] }).success).toBe(false);
    expect(createDownloadBodySchema.safeParse({ fileIds: [] }).success).toBe(false);
  });
});

describe('folder cover', () => {
  it('sets, clears or leaves the cover', () => {
    expect(updateFolderBodySchema.parse({ coverFileId: id })).toEqual({ coverFileId: id });
    expect(updateFolderBodySchema.parse({ coverFileId: null })).toEqual({ coverFileId: null });
    expect(updateFolderBodySchema.safeParse({}).success).toBe(false);
    expect(updateFolderBodySchema.safeParse({ coverFileId: 'nope' }).success).toBe(false);
    const folder = {
      kind: 'folder',
      id,
      parentId: null,
      name: 'Run',
      createdAt: at,
      deletedAt: null,
      faceIndexEnabled: true,
      faceIndexExpiresAt: at,
      coverFileId: id,
    };
    expect(driveFolderSchema.parse(folder)).toEqual(folder);
    expect(driveFolderSchema.safeParse({ ...folder, coverFileId: undefined }).success).toBe(false);
  });

  it('answers COVER_FILE_INVALID with a reason', () => {
    expect(ERROR_HTTP_STATUS.COVER_FILE_INVALID).toBe(422);
    expect(DRIVE_ROUTES.updateFolder.errors).toContain(ErrorCode.COVER_FILE_INVALID);
    const details = ERROR_DETAILS_SCHEMAS.COVER_FILE_INVALID;
    expect(details.parse({ reason: 'outside_folder' })).toEqual({ reason: 'outside_folder' });
    expect(details.safeParse({ reason: 'too_big' }).success).toBe(false);
  });
});

describe('face index always on', () => {
  it('needs no photographer confirmation and keeps the off switch', () => {
    expect(updateFaceIndexBodySchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(updateFaceIndexBodySchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('shares the expiry default with the migration', () => {
    expect(FACE_INDEX_EXPIRY_DAYS_DEFAULT).toBe(90);
    expect(loadRetentionConfig({}).faceIndexExpiryDays).toBe(FACE_INDEX_EXPIRY_DAYS_DEFAULT);
  });
});

describe('admin sign-in without TOTP (ADR 0011 decision 4)', () => {
  const tokens = {
    accessToken: 'eyJ.x.y',
    refreshToken: 'A'.repeat(43),
    expiresIn: 900,
    refreshExpiresIn: 43_200,
    user: { email: 'admin@example.com', name: null },
  };

  it('login answers signed_in or change_password; the password step answers signed_in', () => {
    expect(ADMIN_SIGN_IN_STEPS_BY_MODE.off).toEqual(['change_password']);
    expect(ADMIN_SIGN_IN_STEPS_BY_MODE.totp).toEqual(['change_password', 'enrol_totp', 'totp']);
    const signedIn = { step: 'signed_in', ...tokens };
    const parsed = adminLoginResponseSchema.safeParse(signedIn);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(adminChangePasswordResponseSchema.safeParse(signedIn).success).toBe(true);
    expect(
      adminLoginResponseSchema.safeParse({
        step: 'change_password',
        challengeId: 'B'.repeat(43),
        expiresIn: 300,
      }).success,
    ).toBe(true);
    expect(adminLoginResponseSchema.safeParse({ step: 'signed_in' }).success).toBe(false);
  });
});
