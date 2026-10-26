import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES } from '../errors';
import {
  ALL_ROUTES,
  API_PREFIX,
  API_ROUTES,
  apiPath,
  COMMON_ROUTE_ERRORS,
  completeUploadBodySchema,
  createFolderBodySchema,
  DRIVE_ROOT,
  DRIVE_ROUTES,
  driveFileSchema,
  driveItemsBodySchema,
  folderIdFromRef,
  folderRefFromId,
  listChildrenParamsSchema,
  listChildrenQuerySchema,
  listChildrenResponseSchema,
  signPartsBodySchema,
  trashItemSchema,
  updateFileBodySchema,
  updateFolderBodySchema,
  UPLOAD_ROUTES,
  uploadInitBodySchema,
  uploadInitResponseSchema,
} from '../index';

const folderId = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const fileId = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';
const now = '2026-10-25T05:12:31.123Z';

const file = {
  kind: 'file' as const,
  id: fileId,
  folderId,
  name: 'IMG_0001.JPG',
  mime: 'image/jpeg',
  mediaKind: 'image' as const,
  sizeBytes: 18_734_112,
  status: 'ready' as const,
  width: 6000,
  height: 4000,
  takenAt: now,
  faceCount: null,
  createdAt: now,
  deletedAt: null,
  thumbUrl:
    'https://photos.example.com/media/derived/p/f/thumb.webp?Expires=1&Signature=x&Key-Pair-Id=K',
};

describe('drive root', () => {
  it('is `root` in paths and null in JSON', () => {
    expect(listChildrenParamsSchema.parse({ id: DRIVE_ROOT })).toEqual({ id: 'root' });
    expect(listChildrenParamsSchema.parse({ id: folderId })).toEqual({ id: folderId });
    expect(listChildrenParamsSchema.safeParse({ id: 'ROOT' }).success).toBe(false);
    expect(folderIdFromRef('root')).toBeNull();
    expect(folderIdFromRef(folderId)).toBe(folderId);
    expect(folderRefFromId(null)).toBe('root');
    expect(createFolderBodySchema.parse({ parentId: null, name: ' งาน ' })).toEqual({
      parentId: null,
      name: 'งาน',
    });
    expect(createFolderBodySchema.safeParse({ parentId: 'root', name: 'a' }).success).toBe(false);
  });
});

describe('drive schemas', () => {
  it('parses the listing query from strings with defaults', () => {
    expect(listChildrenQuerySchema.parse({})).toEqual({ sort: 'name', order: 'asc' });
    expect(
      listChildrenQuerySchema.parse({ limit: '50', sort: 'createdAt', order: 'desc' }),
    ).toEqual({
      limit: 50,
      sort: 'createdAt',
      order: 'desc',
    });
    for (const limit of ['0', '501', '1.5', 'x']) {
      expect(listChildrenQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('validates a listing page with optional signed URLs', () => {
    const page = {
      folder: null,
      ancestors: [],
      items: [
        {
          kind: 'folder',
          id: folderId,
          parentId: null,
          name: 'งานวิ่ง',
          createdAt: now,
          deletedAt: null,
          faceIndexEnabled: true,
          faceIndexExpiresAt: now,
        },
        file,
        { ...file, id: folderId, status: 'processing', thumbUrl: undefined },
      ],
      nextCursor: null,
    };
    expect(listChildrenResponseSchema.parse(page).items).toHaveLength(3);
    expect(driveFileSchema.safeParse({ ...file, thumbUrl: 'not a url' }).success).toBe(false);
  });

  it('requires something to change in PATCH bodies and tells absent from null', () => {
    expect(updateFolderBodySchema.safeParse({}).success).toBe(false);
    expect(updateFolderBodySchema.parse({ parentId: null })).toEqual({ parentId: null });
    expect(updateFolderBodySchema.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(updateFileBodySchema.safeParse({}).success).toBe(false);
    expect(updateFileBodySchema.parse({ folderId: null, name: 'a.jpg' })).toEqual({
      folderId: null,
      name: 'a.jpg',
    });
    expect(updateFileBodySchema.safeParse({ name: 'a/b.jpg' }).success).toBe(false);
  });

  it('takes 1 to 500 distinct items for trash and restore', () => {
    const item = { kind: 'file', id: fileId };
    expect(driveItemsBodySchema.safeParse({ items: [item] }).success).toBe(true);
    expect(driveItemsBodySchema.safeParse({ items: [] }).success).toBe(false);
    expect(driveItemsBodySchema.safeParse({ items: [item, item] }).success).toBe(false);
    expect(
      driveItemsBodySchema.safeParse({ items: [item, { kind: 'folder', id: fileId }] }).success,
    ).toBe(true);
    const many = Array.from({ length: 501 }, (_, i) => ({
      kind: 'file',
      id: `0195f3a2-8d2f-7e5b-8c3a-${String(i).padStart(12, '0')}`,
    }));
    expect(driveItemsBodySchema.safeParse({ items: many }).success).toBe(false);
  });

  it('adds purgeAt to trash items', () => {
    expect(trashItemSchema.safeParse({ ...file, deletedAt: now, purgeAt: now }).success).toBe(true);
    expect(trashItemSchema.safeParse({ ...file, deletedAt: now }).success).toBe(false);
  });
});

describe('upload schemas', () => {
  const init = { name: 'IMG_0001.JPG', size: 18_734_112, mime: 'image/jpeg', folderId: null };

  it('parses init with defaults and a relative path', () => {
    expect(uploadInitBodySchema.parse(init)).toEqual({ ...init, onNameConflict: 'rename' });
    expect(
      uploadInitBodySchema.parse({
        ...init,
        folderId,
        relativePath: 'Event/Day 1',
        onNameConflict: 'fail',
      }),
    ).toEqual({ ...init, folderId, relativePath: ['Event', 'Day 1'], onNameConflict: 'fail' });
  });

  it.each([
    ['a zero size', { size: 0 }],
    ['a fractional size', { size: 1.5 }],
    ['a missing folderId', { folderId: undefined }],
    ['folderId root', { folderId: 'root' }],
    ['a name with a slash', { name: 'a/b.jpg' }],
    ['an absolute relative path', { relativePath: '/Event' }],
  ])('rejects %s', (_label, change) => {
    expect(uploadInitBodySchema.safeParse({ ...init, ...change }).success).toBe(false);
  });

  it('leaves type and size limits to the API so clients get specific codes', () => {
    expect(
      uploadInitBodySchema.safeParse({ ...init, name: 'a.heic', mime: 'image/heic' }).success,
    ).toBe(true);
    expect(uploadInitBodySchema.safeParse({ ...init, size: 2 ** 40 }).success).toBe(true);
  });

  it('validates the init response', () => {
    const response = {
      fileId,
      uploadId: 'VXBsb2FkSWQ.example-~_',
      file: { ...file, status: 'uploading', thumbUrl: undefined },
      createdFolders: [],
      partSize: 16 * 1024 * 1024,
      partCount: 2,
      maxConcurrency: 4,
      parts: [
        {
          partNumber: 1,
          url: 'https://shotx-prod-media.s3.ap-southeast-1.amazonaws.com/x?X-Amz-Signature=y',
        },
      ],
      partUrlsExpireAt: now,
      expiresAt: now,
    };
    expect(uploadInitResponseSchema.safeParse(response).success).toBe(true);
    expect(uploadInitResponseSchema.safeParse({ ...response, partCount: 10_001 }).success).toBe(
      false,
    );
  });

  it('signs 1 to 100 distinct parts', () => {
    expect(signPartsBodySchema.safeParse({ partNumbers: [1, 2] }).success).toBe(true);
    expect(signPartsBodySchema.safeParse({ partNumbers: [1, 1] }).success).toBe(false);
    expect(signPartsBodySchema.safeParse({ partNumbers: [0] }).success).toBe(false);
    expect(signPartsBodySchema.safeParse({ partNumbers: [10_001] }).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(signPartsBodySchema.safeParse({ partNumbers: many }).success).toBe(false);
  });

  it('completes with strictly ascending parts', () => {
    const parts = [
      { partNumber: 1, etag: '"9b2cf535f27731c974343645a3985328"' },
      { partNumber: 2, etag: '"a"' },
    ];
    expect(completeUploadBodySchema.safeParse({ parts }).success).toBe(true);
    expect(completeUploadBodySchema.safeParse({ parts: [...parts].reverse() }).success).toBe(false);
    expect(completeUploadBodySchema.safeParse({ parts: [parts[0], parts[0]] }).success).toBe(false);
    expect(completeUploadBodySchema.safeParse({ parts: [] }).success).toBe(false);
  });
});

describe('route table', () => {
  it('covers every Phase 2, 3 and 4 route of the spec, the added ones and auth (ADR 0008)', () => {
    const routes = ALL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(routes).toEqual([
      'GET /drive/folders/:id/children',
      'POST /drive/folders',
      'PATCH /drive/folders/:id',
      'PATCH /drive/files/:id',
      'POST /drive/items/trash',
      'POST /drive/items/restore',
      'GET /drive/trash',
      'DELETE /drive/trash',
      'PATCH /drive/folders/:id/face-index',
      'GET /drive/files/:id/download',
      'GET /drive/usage',
      'POST /uploads/init',
      'POST /uploads/:id/parts',
      'GET /uploads/:id/parts',
      'POST /uploads/:id/complete',
      'DELETE /uploads/:id',
      'GET /me',
      'POST /me/photographer',
      'POST /me/viewer-session',
      'DELETE /me/viewer-session',
      'POST /shares',
      'GET /shares',
      'GET /shares/:id',
      'PATCH /shares/:id',
      'DELETE /shares/:id',
      'GET /shares/:id/stats',
      'GET /s/:token',
      'GET /s/:token/items',
      'POST /s/:token/unlock',
      'POST /s/:token/consent',
      'DELETE /s/:token/consent',
      'POST /s/:token/face-search',
      'POST /s/:token/feedback',
      'GET /s/:token/face-deletion',
      'POST /s/:token/face-deletion',
      'POST /s/:token/downloads',
      'GET /s/:token/zip-jobs/:id',
      'GET /plans',
      'POST /billing/checkout',
      'GET /billing/payments/:id',
      'GET /billing/subscription',
      'POST /billing/subscription/cancel',
      'POST /billing/webhooks/:gateway',
      'GET /auth/providers',
      'POST /auth/oidc/:provider/start',
      'POST /auth/oidc/callback',
      'POST /auth/dev/login',
      'POST /auth/refresh',
      'POST /auth/logout',
      'POST /auth/admin/login',
      'POST /auth/admin/mfa',
    ]);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('lists only known error codes, including the common ones', () => {
    for (const route of ALL_ROUTES) {
      for (const code of route.errors) expect(ERROR_CODES).toContain(code);
      // Webhooks have no token, viewer or Origin: only validation and internal errors are common.
      if (route.auth !== 'webhook') {
        expect(route.errors).toEqual(expect.arrayContaining([...COMMON_ROUTE_ERRORS]));
      }
      expect(new Set(route.errors).size).toBe(route.errors.length);
    }
    expect(UPLOAD_ROUTES.init.errors).toEqual(
      expect.arrayContaining([
        'QUOTA_EXCEEDED',
        'SUBSCRIPTION_INACTIVE',
        'UNSUPPORTED_FILE_TYPE',
        'FILE_TOO_LARGE',
      ]),
    );
    expect(DRIVE_ROUTES.updateFolder.errors).toEqual(
      expect.arrayContaining(['INVALID_MOVE', 'NAME_TAKEN']),
    );
  });

  it('has a body schema exactly for routes that have one, and no response for 204', () => {
    for (const route of ALL_ROUTES) {
      expect(route.status === 204, `${route.method} ${route.path}`).toBe(
        route.response === undefined,
      );
      if (route.method === 'GET' || route.method === 'DELETE') expect(route.body).toBeUndefined();
      expect(route.body !== undefined && route.multipart !== undefined).toBe(false);
      if (route.path.includes(':')) expect(route.params).toBeDefined();
    }
  });

  it('builds prefixed, encoded paths', () => {
    expect(API_PREFIX).toBe('/api');
    expect(apiPath(DRIVE_ROUTES.listChildren, { id: DRIVE_ROOT })).toBe(
      '/api/drive/folders/root/children',
    );
    expect(apiPath(API_ROUTES.uploads.complete, { id: fileId })).toBe(
      `/api/uploads/${fileId}/complete`,
    );
    expect(apiPath(DRIVE_ROUTES.usage)).toBe('/api/drive/usage');
    expect(apiPath(DRIVE_ROUTES.updateFile, { id: 'a/b' }, { prefix: false })).toBe(
      '/drive/files/a%2Fb',
    );
    expect(() => apiPath(DRIVE_ROUTES.updateFile, { id: '' })).toThrow(/Missing path param id/);
  });

  it('types path params', () => {
    // @ts-expect-error id is required
    expect(() => apiPath(DRIVE_ROUTES.updateFolder, {})).toThrow();
    // @ts-expect-error unknown param
    apiPath(DRIVE_ROUTES.usage, { id: 'x' });
    expectTypeOf(apiPath(DRIVE_ROUTES.usage)).toEqualTypeOf<string>();
  });
});
