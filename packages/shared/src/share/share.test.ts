import { describe, expect, it } from 'vitest';
import {
  activityEventInputSchema,
  anonIdCookie,
  base62Of128Bits,
  bucketedExpiry,
  bucketedSigningDate,
  contentDispositionAttachment,
  downloadObject,
  faceMatchBucket,
  faceOnlyGrantAllows,
  faceScanResultKey,
  faceSearchUnavailableReason,
  formatSimilarity,
  generateOpaqueToken,
  generateShareToken,
  ipHashInput,
  isCoveredByFaceIndex,
  isFileInShareScope,
  isShareToken,
  isValidAnonId,
  ltreeContains,
  mergeFaceScanResult,
  ownerShareStatus,
  SHARE_TOKEN_LENGTH,
  shareAccessGate,
  shareAvailability,
  shareTokenSchema,
  shareUnlockCookie,
  shareUnlockKey,
  shareUrl,
  viewerColumns,
  viewerKey,
  viewerSessionCookie,
  viewerSessionKey,
  type FaceIndexFolder,
  type ScopeFile,
  type ShareTargetRef,
} from '../index';

const owner = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const other = '0195f3a2-0000-7000-8000-000000000000';
const shareId = '0195f3a2-af4b-7a7d-8e5c-6f7a8b9cadbe';
const fileId = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';
const anonId = '3b241101-e2bb-4255-8caf-4136c566a962';
const hash = 'a'.repeat(64);

describe('share tokens', () => {
  it('encodes 128 bits as exactly 22 base62 characters', () => {
    expect(base62Of128Bits(new Uint8Array(16))).toBe('0'.repeat(22));
    // 2^128 - 1 = 7n42DGM5Tflk9n8mt7Fhc7 in base62.
    expect(base62Of128Bits(new Uint8Array(16).fill(255))).toBe('7n42DGM5Tflk9n8mt7Fhc7');
    expect(() => base62Of128Bits(new Uint8Array(15))).toThrow(RangeError);
  });

  it('draws tokens from the CSPRNG', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateShareToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
      expect(isShareToken(token)).toBe(true);
      expect(shareTokenSchema.safeParse(token).success).toBe(true);
    }
    expect(generateOpaqueToken(() => new Uint8Array(16))).toBe('0'.repeat(22));
  });

  it('rejects anything else as a token', () => {
    for (const bad of ['', 'a'.repeat(21), 'a'.repeat(23), `${'a'.repeat(21)}-`, '../etc/passwd']) {
      expect(isShareToken(bad)).toBe(false);
    }
  });

  it('builds share links', () => {
    const token = 'Ab3dEf6hIj9kLm2oPq5sTu';
    expect(shareUrl('https://photos.example.com/', token)).toBe(
      'https://photos.example.com/Ab3dEf6hIj9kLm2oPq5sTu',
    );
    expect(() => shareUrl('https://photos.example.com', 'x/../y')).toThrow(RangeError);
  });
});

describe('bucketedExpiry', () => {
  const at = (iso: string) => new Date(iso);

  it('returns ceil(now / bucket) * bucket + ttl', () => {
    expect(bucketedExpiry(at('2026-10-25T05:01:10.500Z'), 3600, 300).toISOString()).toBe(
      '2026-10-25T06:05:00.000Z',
    );
    // On a boundary, the window ends now.
    expect(bucketedExpiry(at('2026-10-25T05:05:00.000Z'), 600, 300).toISOString()).toBe(
      '2026-10-25T05:15:00.000Z',
    );
  });

  it('gives the same expiry within a window, so signed URLs are identical', () => {
    const first = bucketedExpiry(at('2026-10-25T05:00:00.001Z'), 3600, 300);
    const last = bucketedExpiry(at('2026-10-25T05:04:59.999Z'), 3600, 300);
    const next = bucketedExpiry(at('2026-10-25T05:05:00.001Z'), 3600, 300);
    expect(first).toEqual(last);
    expect(next.getTime() - first.getTime()).toBe(300_000);
  });

  it('keeps every URL valid for at least ttl and at most ttl + bucket', () => {
    for (let ms = 0; ms < 600_000; ms += 7_919) {
      const now = new Date(Date.UTC(2026, 9, 25) + ms);
      const left = (bucketedExpiry(now, 600, 300).getTime() - now.getTime()) / 1000;
      expect(left).toBeGreaterThanOrEqual(600);
      expect(left).toBeLessThanOrEqual(900);
    }
  });

  it('rejects bad inputs', () => {
    const now = new Date();
    expect(() => bucketedExpiry(now, 0, 300)).toThrow(RangeError);
    expect(() => bucketedExpiry(now, 600, 0)).toThrow(RangeError);
    expect(() => bucketedExpiry(now, 600, 2.5)).toThrow(RangeError);
    expect(() => bucketedExpiry(new Date(Number.NaN), 600, 300)).toThrow(RangeError);
  });
});

describe('bucketedSigningDate', () => {
  const at = (iso: string) => new Date(iso);

  it('rounds down to the bucket, so one window gives one signing date', () => {
    const first = bucketedSigningDate(at('2026-10-25T05:00:00.000Z'), 300);
    expect(first.toISOString()).toBe('2026-10-25T05:00:00.000Z');
    expect(bucketedSigningDate(at('2026-10-25T05:04:59.999Z'), 300)).toEqual(first);
    expect(bucketedSigningDate(at('2026-10-25T05:05:00.000Z'), 300).toISOString()).toBe(
      '2026-10-25T05:05:00.000Z',
    );
  });

  it('keeps the URL valid for at least the TTL and at most TTL + 2 x bucket', () => {
    for (const iso of [
      '2026-10-25T05:00:00.000Z',
      '2026-10-25T05:02:30.250Z',
      '2026-10-25T05:04:59.999Z',
    ]) {
      const now = at(iso);
      const expires =
        (bucketedExpiry(now, 600, 300).getTime() - bucketedSigningDate(now, 300).getTime()) / 1000;
      expect(expires, iso).toBeGreaterThanOrEqual(600);
      expect(expires, iso).toBeLessThanOrEqual(600 + 2 * 300);
      expect(bucketedSigningDate(now, 300).getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('rejects bad input', () => {
    expect(() => bucketedSigningDate(new Date(), 0)).toThrow(RangeError);
    expect(() => bucketedSigningDate(new Date(), 1.5)).toThrow(RangeError);
    expect(() => bucketedSigningDate(new Date(Number.NaN), 300)).toThrow(RangeError);
  });
});

describe('contentDispositionAttachment', () => {
  it('keeps Thai names with an ASCII fallback', () => {
    expect(contentDispositionAttachment('งานวิ่ง 1.jpg')).toBe(
      `attachment; filename="_______ 1.jpg"; filename*=UTF-8''%E0%B8%87%E0%B8%B2%E0%B8%99%E0%B8%A7%E0%B8%B4%E0%B9%88%E0%B8%87%201.jpg`,
    );
  });

  it('neutralises quotes and backslashes in the fallback', () => {
    expect(contentDispositionAttachment('a"b\\c.jpg')).toBe(
      `attachment; filename="a_b_c.jpg"; filename*=UTF-8''a%22b%5Cc.jpg`,
    );
    expect(() => contentDispositionAttachment('')).toThrow(RangeError);
  });
});

describe('share scope', () => {
  const root = 'aa.bb';
  const folderShare: ShareTargetRef = {
    ownerId: owner,
    targetType: 'folder',
    targetFileId: null,
    targetFolderId: 'bb',
  };
  const file = (values: Partial<ScopeFile> = {}): ScopeFile => ({
    id: fileId,
    ownerId: owner,
    status: 'ready',
    deletedAt: null,
    purgeRequestedAt: null,
    folderPath: 'aa.bb.cc',
    ...values,
  });

  it('compares ltree paths label by label', () => {
    expect(ltreeContains('aa.bb', 'aa.bb')).toBe(true);
    expect(ltreeContains('aa.bb', 'aa.bb.cc')).toBe(true);
    expect(ltreeContains('aa.bb', 'aa.bbc')).toBe(false);
    expect(ltreeContains('aa.bb.cc', 'aa.bb')).toBe(false);
    expect(() => ltreeContains('aa..bb', 'aa')).toThrow(RangeError);
    expect(() => ltreeContains('aa', 'a-b')).toThrow(RangeError);
  });

  it('serves ready, live files of the owner inside the root', () => {
    expect(isFileInShareScope(folderShare, root, file())).toBe(true);
    expect(isFileInShareScope(folderShare, root, file({ folderPath: root }))).toBe(true);
    expect(isFileInShareScope(folderShare, root, file({ folderPath: 'aa' }))).toBe(false);
    expect(isFileInShareScope(folderShare, root, file({ folderPath: 'aa.bbc' }))).toBe(false);
    expect(isFileInShareScope(folderShare, root, file({ folderPath: null }))).toBe(false);
    expect(isFileInShareScope(folderShare, null, file())).toBe(false);
  });

  it('follows moves: only the current root path counts', () => {
    // The folder `bb` moved from under `aa` to under `xx`; its files moved with it.
    expect(isFileInShareScope(folderShare, 'xx.bb', file({ folderPath: 'xx.bb.cc' }))).toBe(true);
    expect(isFileInShareScope(folderShare, 'xx.bb', file({ folderPath: 'aa.bb.cc' }))).toBe(false);
  });

  it('never serves trashed, purging, unready or foreign files', () => {
    for (const values of [
      { deletedAt: new Date() },
      { purgeRequestedAt: new Date() },
      { status: 'processing' as const },
      { status: 'failed' as const },
      { ownerId: other },
    ]) {
      expect(isFileInShareScope(folderShare, root, file(values))).toBe(false);
    }
  });

  it('serves only the file itself for a file share', () => {
    const fileShare: ShareTargetRef = {
      ownerId: owner,
      targetType: 'file',
      targetFileId: fileId,
      targetFolderId: null,
    };
    expect(isFileInShareScope(fileShare, null, file({ folderPath: null }))).toBe(true);
    expect(isFileInShareScope(fileShare, null, file({ id: other }))).toBe(false);
  });
});

describe('share availability and gates', () => {
  const now = new Date('2026-10-25T05:00:00Z');
  const live = {
    isActive: true,
    expiresAt: null,
    targetLive: true,
    ownerStatus: 'active',
    subscriptionGates: true,
    subscriptionStatus: 'active',
  } as const;

  it('checks revoked, expired, then unavailable', () => {
    expect(shareAvailability({ ...live, subscriptionStatus: 'active' }, now)).toEqual({ ok: true });
    expect(shareAvailability({ ...live, subscriptionStatus: 'grace' }, now)).toEqual({ ok: true });
    expect(
      shareAvailability(
        { ...live, subscriptionStatus: 'active', isActive: false, expiresAt: now },
        now,
      ),
    ).toEqual({ ok: false, code: 'SHARE_EXPIRED', reason: 'revoked' });
    expect(
      shareAvailability({ ...live, subscriptionStatus: 'active', expiresAt: now }, now),
    ).toEqual({ ok: false, code: 'SHARE_EXPIRED', reason: 'expired' });
    for (const subscriptionStatus of ['expired', 'purged', null] as const) {
      expect(shareAvailability({ ...live, subscriptionStatus }, now)).toEqual({
        ok: false,
        code: 'SHARE_EXPIRED',
        reason: 'unavailable',
      });
    }
    expect(
      shareAvailability({ ...live, subscriptionStatus: 'trial', targetLive: false }, now),
    ).toMatchObject({ reason: 'unavailable' });
  });

  it('makes a disabled owner unavailable, after revoked and expired (ADR 0010)', () => {
    expect(shareAvailability({ ...live, ownerStatus: 'disabled' }, now)).toEqual({
      ok: false,
      code: 'SHARE_EXPIRED',
      reason: 'unavailable',
    });
    expect(
      shareAvailability({ ...live, ownerStatus: 'disabled', subscriptionGates: false }, now),
    ).toMatchObject({ reason: 'unavailable' });
    expect(
      shareAvailability({ ...live, ownerStatus: 'disabled', isActive: false }, now),
    ).toMatchObject({ reason: 'revoked' });
    expect(
      shareAvailability({ ...live, ownerStatus: 'disabled', expiresAt: now }, now),
    ).toMatchObject({ reason: 'expired' });
  });

  it('ignores the subscription when it does not gate (BILLING_MODE=offline)', () => {
    const offline = { ...live, subscriptionGates: false };
    for (const subscriptionStatus of ['expired', 'purged', null] as const) {
      expect(shareAvailability({ ...offline, subscriptionStatus }, now)).toEqual({ ok: true });
    }
    // Everything else still applies.
    expect(shareAvailability({ ...offline, targetLive: false }, now)).toMatchObject({
      reason: 'unavailable',
    });
    expect(shareAvailability({ ...offline, isActive: false }, now)).toMatchObject({
      reason: 'revoked',
    });
  });

  it('derives the owner-facing status', () => {
    expect(ownerShareStatus({ isActive: true, expiresAt: null }, now)).toBe('active');
    expect(ownerShareStatus({ isActive: true, expiresAt: now }, now)).toBe('expired');
    expect(ownerShareStatus({ isActive: false, expiresAt: null }, now)).toBe('revoked');
  });

  it('asks for login before the password', () => {
    const both = { requireLogin: true, passwordProtected: true };
    expect(shareAccessGate(both, { signedIn: false, unlocked: false })).toBe('LOGIN_REQUIRED');
    expect(shareAccessGate(both, { signedIn: true, unlocked: false })).toBe('PASSWORD_REQUIRED');
    expect(shareAccessGate(both, { signedIn: true, unlocked: true })).toBeNull();
    expect(
      shareAccessGate(
        { requireLogin: false, passwordProtected: false },
        { signedIn: false, unlocked: false },
      ),
    ).toBeNull();
  });
});

describe('face index coverage', () => {
  const now = new Date('2026-10-25T05:00:00Z');
  const later = new Date('2027-01-23T05:00:00Z');
  const folder = (path: string, values: Partial<FaceIndexFolder> = {}): FaceIndexFolder => ({
    path,
    faceIndexEnabled: true,
    faceIndexExpiresAt: later,
    deletedAt: null,
    ...values,
  });

  it('covers the subtree of an active folder only', () => {
    const folders = [folder('aa.bb')];
    expect(isCoveredByFaceIndex('aa.bb', folders, now)).toBe(true);
    expect(isCoveredByFaceIndex('aa.bb.cc', folders, now)).toBe(true);
    expect(isCoveredByFaceIndex('aa', folders, now)).toBe(false);
    expect(isCoveredByFaceIndex(null, folders, now)).toBe(false);
    expect(isCoveredByFaceIndex('aa.bb', folders, later)).toBe(false);
    expect(isCoveredByFaceIndex('aa.bb', [folder('aa.bb', { faceIndexEnabled: false })], now)).toBe(
      false,
    );
    expect(isCoveredByFaceIndex('aa.bb', [folder('aa.bb', { deletedAt: now })], now)).toBe(false);
  });

  it('offers face search on folder shares with an index above or below the root', () => {
    const share = { targetType: 'folder' as const };
    expect(faceSearchUnavailableReason(share, 'aa.bb', [folder('aa')], now)).toBeNull();
    expect(faceSearchUnavailableReason(share, 'aa.bb', [folder('aa.bb.cc')], now)).toBeNull();
    expect(faceSearchUnavailableReason(share, 'aa.bb', [folder('aa.xx')], now)).toBe('not_indexed');
    expect(faceSearchUnavailableReason(share, 'aa.bb', [], now)).toBe('not_indexed');
    expect(faceSearchUnavailableReason({ targetType: 'file' }, null, [folder('aa')], now)).toBe(
      'not_folder_share',
    );
  });
});

describe('viewer identity', () => {
  it('keys viewers and fills exactly one column', () => {
    expect(viewerKey({ kind: 'user', viewerId: owner })).toBe(`u:${owner}`);
    expect(viewerKey({ kind: 'anon', anonId })).toBe(`a:${anonId}`);
    expect(() => viewerKey({ kind: 'anon', anonId: 'x' })).toThrow();
    expect(viewerColumns({ kind: 'anon', anonId })).toEqual({ viewerId: null, anonId });
    expect(viewerColumns({ kind: 'user', viewerId: owner })).toEqual({
      viewerId: owner,
      anonId: null,
    });
  });

  it('accepts only API-made anon ids', () => {
    expect(isValidAnonId(anonId)).toBe(true);
    expect(isValidAnonId(anonId.toUpperCase())).toBe(false);
    expect(isValidAnonId(owner)).toBe(false); // uuidv7, not v4
  });

  it('describes the cookies', () => {
    expect(anonIdCookie(365, true)).toEqual({
      name: 'shotx_anon',
      path: '/',
      maxAgeSeconds: 31_536_000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    expect(viewerSessionCookie(43_200, true)).toMatchObject({ name: 'shotx_vs', path: '/api' });
    expect(shareUnlockCookie('Ab3dEf6hIj9kLm2oPq5sTu', 86_400, false)).toMatchObject({
      name: 'shotx_unlock',
      path: '/api/s/Ab3dEf6hIj9kLm2oPq5sTu',
      secure: false,
    });
    expect(() => shareUnlockCookie('bad/token', 60, true)).toThrow(RangeError);
  });

  it('normalises addresses before hashing', () => {
    expect(ipHashInput(' ::FFFF:203.0.113.10 ')).toBe('203.0.113.10');
    expect(ipHashInput('2001:DB8::1%eth0')).toBe('2001:db8::1');
    expect(ipHashInput('203.0.113.10')).toBe('203.0.113.10');
  });
});

describe('face-search results and the face_only grant', () => {
  it('builds Redis keys from validated segments only', () => {
    expect(faceScanResultKey(shareId, { kind: 'anon', anonId })).toBe(
      `face-scan:${shareId}:a:${anonId}`,
    );
    expect(shareUnlockKey(shareId, hash)).toBe(`share-unlock:${shareId}:${hash}`);
    expect(viewerSessionKey(hash)).toBe(`viewer-session:${hash}`);
    expect(() => shareUnlockKey('x', hash)).toThrow();
    expect(() => viewerSessionKey('A'.repeat(64))).toThrow(RangeError);
  });

  it('merges scans keeping the best similarity per file', () => {
    const existing = { [fileId]: '96.0' };
    expect(
      mergeFaceScanResult(existing, [
        { fileId, similarity: 91.04 },
        { fileId: other, similarity: 88.26 },
        { fileId: other, similarity: 89.99 },
      ]),
    ).toEqual({ [other]: '90.0' });
    expect(mergeFaceScanResult(existing, [{ fileId, similarity: 99.5 }])).toEqual({
      [fileId]: '99.5',
    });
    expect(() => formatSimilarity(101)).toThrow(RangeError);
    expect(() => mergeFaceScanResult({}, [{ fileId: 'x', similarity: 90 }])).toThrow();
  });

  it('buckets by the thresholds', () => {
    const thresholds = { strong: 95, maybe: 85 };
    expect(faceMatchBucket(95, thresholds)).toBe('strong');
    expect(faceMatchBucket(94.9, thresholds)).toBe('maybe');
    expect(faceMatchBucket(84.9, thresholds)).toBeNull();
  });

  it('allows everything in gallery mode and only granted files in face_only mode', () => {
    const granted = new Set([fileId]);
    expect(faceOnlyGrantAllows('gallery', null, other)).toBe(true);
    expect(faceOnlyGrantAllows('face_only', granted, fileId)).toBe(true);
    expect(faceOnlyGrantAllows('face_only', granted, other)).toBe(false);
    expect(faceOnlyGrantAllows('face_only', null, fileId)).toBe(false);
  });
});

describe('activity events', () => {
  const share = { source: 'share', shareId, photographerId: owner, viewerId: null, anonId };

  it('accepts counts-only events', () => {
    for (const event of [
      { ...share, type: 'view', fileId: null, bytes: 0, meta: { items: 100 } },
      {
        ...share,
        type: 'scan',
        fileId: null,
        bytes: 0,
        meta: { selfies: 3, strong: 12, maybe: 4 },
      },
      { ...share, type: 'download', fileId, bytes: 1_200_000, meta: null },
      { ...share, type: 'zip', fileId: null, bytes: 3_000_000_000, meta: { files: 120 } },
      {
        source: 'owner',
        shareId: null,
        photographerId: owner,
        viewerId: null,
        anonId: null,
        type: 'download',
        fileId,
        bytes: 18_734_112,
        meta: null,
      },
      // An owner folder zip (Wave 7, GET /drive/zip-jobs/:id).
      {
        source: 'owner',
        shareId: null,
        photographerId: owner,
        viewerId: null,
        anonId: null,
        type: 'zip',
        fileId: null,
        bytes: 2_000_000_000,
        meta: { files: 300 },
      },
    ]) {
      expect(activityEventInputSchema.safeParse(event).success).toBe(true);
    }
  });

  it('rejects biometrics and inconsistent sources', () => {
    const bad = [
      // Extra fields are refused (strict): no face ids, boxes or scores can slip in.
      {
        ...share,
        type: 'scan',
        fileId: null,
        bytes: 0,
        meta: { selfies: 1, strong: 1, maybe: 0, faceIds: 1 },
      },
      {
        ...share,
        type: 'scan',
        fileId: null,
        bytes: 0,
        meta: { selfies: 1, strong: 1, maybe: 0 },
        bbox: {},
      },
      { ...share, type: 'view', fileId, bytes: 0, meta: { items: 1 } },
      { ...share, shareId: null, type: 'download', fileId, bytes: 1, meta: null },
      { ...share, source: 'owner', type: 'download', fileId, bytes: 1, meta: null },
      { ...share, source: 'owner', type: 'view', fileId: null, bytes: 0, meta: { items: 1 } },
      // Owner zips have no share and no viewer, and are still counts only.
      { ...share, source: 'owner', type: 'zip', fileId: null, bytes: 1, meta: { files: 1 } },
      {
        ...share,
        source: 'owner',
        shareId: null,
        anonId: null,
        viewerId: owner,
        type: 'zip',
        fileId: null,
        bytes: 1,
        meta: { files: 1 },
      },
      {
        source: 'owner',
        shareId: null,
        photographerId: owner,
        viewerId: null,
        anonId: null,
        type: 'zip',
        fileId,
        bytes: 1,
        meta: { files: 1 },
      },
      {
        ...share,
        source: 'owner',
        shareId: null,
        anonId: null,
        type: 'scan',
        fileId: null,
        bytes: 0,
        meta: { selfies: 1, strong: 0, maybe: 0 },
      },
      { ...share, viewerId: owner, type: 'download', fileId, bytes: 1, meta: null },
      { ...share, anonId: null, type: 'download', fileId, bytes: 1, meta: null },
    ];
    for (const event of bad) expect(activityEventInputSchema.safeParse(event).success).toBe(false);
  });
});

describe('downloadObject', () => {
  const image = {
    mediaKind: 'image' as const,
    name: 'IMG_0001.PNG',
    s3Key: 'originals/p/f/IMG_0001.PNG',
    webKey: 'derived/p/f/web.jpg',
    previewKey: 'derived/p/f/preview.webp',
    sizeBytes: 18_000_000,
    webSizeBytes: 900_000,
  };

  it('serves web.jpg or the original', () => {
    expect(downloadObject(image, 'web')).toEqual({
      key: 'derived/p/f/web.jpg',
      fileName: 'IMG_0001.jpg',
      bytes: 900_000,
    });
    expect(downloadObject(image, 'original')).toEqual({
      key: 'originals/p/f/IMG_0001.PNG',
      fileName: 'IMG_0001.PNG',
      bytes: 18_000_000,
    });
    expect(downloadObject({ ...image, webKey: null }, 'web')).toBeNull();
    expect(downloadObject({ ...image, webSizeBytes: null }, 'web')?.bytes).toBe(0);
  });

  it('serves preview.mp4 as the web size of a video', () => {
    const video = {
      ...image,
      mediaKind: 'video' as const,
      name: 'วิ่ง/clip.MOV',
      webKey: null,
      previewKey: 'derived/p/f/preview.mp4',
    };
    expect(downloadObject(video, 'web')).toEqual({
      key: 'derived/p/f/preview.mp4',
      fileName: 'วิ่ง_clip.mp4',
      bytes: 900_000,
    });
  });
});
