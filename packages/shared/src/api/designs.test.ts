import { describe, expect, it } from 'vitest';
import { designDocSchema } from '../design/doc';
import { blankDesignDoc, designTemplateDoc } from '../design/templates';
import { ERROR_DETAILS_SCHEMAS, ERROR_HTTP_STATUS, ErrorCode } from '../errors';
import {
  createDesignAssetBodySchema,
  createDesignAssetResponseSchema,
  createDesignBodySchema,
  designAssetViewSchema,
  designNameSchema,
  designSchema,
  listDesignAssetsQuerySchema,
  listDesignsResponseSchema,
  updateDesignBodySchema,
} from './designs';
import { apiPath, DESIGN_ROUTES, type HttpMethod, SHARE_ROUTES } from './routes';
import { shareMetaDesignSchema, shareMetaResponseSchema } from './share-page';
import { createShareBodySchema, ownerShareSchema, updateShareBodySchema } from './shares';

// Contracts of ADR 0013 (share page designer).

const id = '0193a5b0-7c1e-7cc3-9b1e-2f3a4b5c6d7e';
const assetId = '0193a5b0-7c1e-7cc3-9b1e-2f3a4b5c6d7f';
const at = '2026-11-12T01:00:00.000Z';
const doc = designTemplateDoc('night-gala');

const readyAsset = {
  id: assetId,
  status: 'ready',
  mime: 'image/png',
  sizeBytes: 123_456,
  width: 1200,
  height: 400,
  url: 'https://snap.example.com/media/designs/x/y/web.webp?Signature=s',
  urlExpiresAt: at,
  createdAt: at,
};

const design = {
  id,
  name: 'งานวิ่งกรุงเทพ 2026',
  isDefault: true,
  revision: 3,
  doc,
  assets: { [assetId]: readyAsset },
  createdAt: at,
  updatedAt: at,
};

describe('design routes', () => {
  it('are photographer-only, with the ADR 0013 methods and paths', () => {
    const routes = Object.values(DESIGN_ROUTES).map((r) => `${r.method} ${r.path}`);
    expect(routes).toEqual([
      'GET /designs',
      'POST /designs',
      'GET /designs/assets',
      'POST /designs/assets',
      'POST /designs/assets/:id/complete',
      'GET /designs/assets/:id',
      'GET /designs/:id',
      'PUT /designs/:id',
      'DELETE /designs/:id',
      'POST /designs/:id/default',
      'DELETE /designs/:id/default',
    ]);
    for (const route of Object.values(DESIGN_ROUTES)) {
      expect(route.auth, route.path).toBe('photographer');
      expect(route.errors, route.path).toEqual(
        expect.arrayContaining(['ACCOUNT_DISABLED', 'PASSWORD_CHANGE_REQUIRED']),
      );
    }
    const put: HttpMethod = DESIGN_ROUTES.update.method;
    expect(put).toBe('PUT');
    expect(apiPath(DESIGN_ROUTES.completeAsset, { id })).toBe(`/api/designs/assets/${id}/complete`);
  });

  it('name the errors each route can answer', () => {
    expect(DESIGN_ROUTES.create.errors).toEqual(
      expect.arrayContaining([
        'DESIGN_LIMIT_REACHED',
        'DESIGN_DOC_TOO_LARGE',
        'DESIGN_ASSET_NOT_FOUND',
      ]),
    );
    expect(DESIGN_ROUTES.update.errors).toEqual(
      expect.arrayContaining([
        'NOT_FOUND',
        'DESIGN_REVISION_CONFLICT',
        'DESIGN_DOC_TOO_LARGE',
        'DESIGN_ASSET_NOT_FOUND',
      ]),
    );
    expect(DESIGN_ROUTES.createAsset.errors).toEqual(
      expect.arrayContaining(['UNSUPPORTED_FILE_TYPE', 'FILE_TOO_LARGE', 'QUOTA_EXCEEDED']),
    );
    expect(DESIGN_ROUTES.completeAsset.errors).toEqual(
      expect.arrayContaining(['NOT_FOUND', 'UPLOAD_EXPIRED', 'CONFLICT']),
    );
    expect(SHARE_ROUTES.create.errors).toContain('DESIGN_NOT_FOUND');
    expect(SHARE_ROUTES.update.errors).toContain('DESIGN_NOT_FOUND');
  });

  it('has the new error codes with statuses and typed details', () => {
    expect({
      DESIGN_REVISION_CONFLICT: ERROR_HTTP_STATUS.DESIGN_REVISION_CONFLICT,
      DESIGN_ASSET_NOT_FOUND: ERROR_HTTP_STATUS.DESIGN_ASSET_NOT_FOUND,
      DESIGN_LIMIT_REACHED: ERROR_HTTP_STATUS.DESIGN_LIMIT_REACHED,
      DESIGN_DOC_TOO_LARGE: ERROR_HTTP_STATUS.DESIGN_DOC_TOO_LARGE,
      DESIGN_NOT_FOUND: ERROR_HTTP_STATUS.DESIGN_NOT_FOUND,
    }).toEqual({
      DESIGN_REVISION_CONFLICT: 409,
      DESIGN_ASSET_NOT_FOUND: 422,
      DESIGN_LIMIT_REACHED: 409,
      DESIGN_DOC_TOO_LARGE: 422,
      DESIGN_NOT_FOUND: 422,
    });
    expect(ErrorCode.DESIGN_REVISION_CONFLICT).toBe('DESIGN_REVISION_CONFLICT');
    const d = ERROR_DETAILS_SCHEMAS;
    expect(d.DESIGN_REVISION_CONFLICT.parse({ currentRevision: 4 })).toEqual({
      currentRevision: 4,
    });
    expect(d.DESIGN_ASSET_NOT_FOUND.safeParse({ assetIds: [] }).success).toBe(false);
    expect(d.DESIGN_ASSET_NOT_FOUND.parse({ assetIds: [assetId] })).toEqual({
      assetIds: [assetId],
    });
    expect(d.DESIGN_LIMIT_REACHED.parse({ maxDesigns: 50 })).toEqual({ maxDesigns: 50 });
    expect(d.DESIGN_DOC_TOO_LARGE.parse({ reason: 'bytes', max: 65_536, actual: 70_000 })).toEqual({
      reason: 'bytes',
      max: 65_536,
      actual: 70_000,
    });
    expect(d.DESIGN_DOC_TOO_LARGE.safeParse({ reason: 'fonts', max: 1, actual: 2 }).success).toBe(
      false,
    );
  });
});

describe('design bodies', () => {
  it('creates from a template (Thai placeholders by default), a document, or blank', () => {
    expect(createDesignBodySchema.parse({ name: 'A', templateId: 'pastel-glow' })).toEqual({
      name: 'A',
      templateId: 'pastel-glow',
      locale: 'th',
    });
    expect(
      createDesignBodySchema.parse({ name: 'A', templateId: 'bold-poster', locale: 'zh' }).locale,
    ).toBe('zh');
    expect(createDesignBodySchema.parse({ name: '  ว่าง  ' })).toEqual({
      name: 'ว่าง',
      locale: 'th',
    });
    expect(createDesignBodySchema.parse({ name: 'copy', doc }).doc).toEqual(doc);
    for (const bad of [
      { name: 'A', templateId: 'pastel-glow', doc },
      { name: 'A', templateId: 'neon-party' },
      { name: 'A', doc: { ...doc, elements: [] } },
      { name: 'A', locale: 'ja' },
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(81) },
      { name: 'a\u0000b' },
      { name: 'A', ownerId: id },
    ]) {
      expect(createDesignBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(
        false,
      );
    }
    expect(designNameSchema.parse('ก'.repeat(80))).toHaveLength(80);
  });

  it('saves with name, document and the revision it started from', () => {
    const body = { name: 'Run', doc: blankDesignDoc(), revision: 1 };
    expect(updateDesignBodySchema.parse(body)).toEqual(body);
    for (const bad of [
      { ...body, revision: 0 },
      { ...body, revision: 1.5 },
      { name: 'Run', doc: blankDesignDoc() },
      { ...body, isDefault: true },
      { ...body, doc: { ...blankDesignDoc(), version: 2 } },
    ]) {
      expect(updateDesignBodySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('starts an image upload with the name, MIME type and exact size', () => {
    const body = { fileName: 'โลโก้.png', mime: 'image/png', sizeBytes: 2048 };
    expect(createDesignAssetBodySchema.parse(body)).toEqual(body);
    // The type and size limits are answered by the api with their own codes, not here.
    expect(createDesignAssetBodySchema.parse({ ...body, mime: 'image/svg+xml' }).mime).toBe(
      'image/svg+xml',
    );
    expect(createDesignAssetBodySchema.parse({ ...body, sizeBytes: 10 ** 12 }).sizeBytes).toBe(
      10 ** 12,
    );
    for (const bad of [
      { ...body, sizeBytes: 0 },
      { ...body, fileName: '' },
      { ...body, key: 'x' },
    ]) {
      expect(createDesignAssetBodySchema.safeParse(bad).success).toBe(false);
    }
    expect(listDesignAssetsQuerySchema.parse({ limit: '20' })).toEqual({ limit: 20 });
    expect(listDesignAssetsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });
});

describe('design responses', () => {
  it('return the design with its asset map', () => {
    expect(designSchema.parse(design)).toEqual(design);
    expect(designSchema.safeParse({ ...design, revision: 0 }).success).toBe(false);
    expect(
      designSchema.safeParse({ ...design, assets: { 'not-a-uuid': readyAsset } }).success,
    ).toBe(false);
  });

  it('list every design with one asset map and the limits', () => {
    const { assets, ...summary } = design;
    const list = {
      items: [summary],
      assets,
      limits: { maxDesigns: 50, maxElements: 60, docMaxBytes: 65_536, assetMaxBytes: 15_728_640 },
    };
    expect(listDesignsResponseSchema.parse(list)).toEqual(list);
  });

  it('show an image without a URL until it is ready', () => {
    const processing = {
      ...readyAsset,
      status: 'processing',
      width: null,
      height: null,
      url: null,
      urlExpiresAt: null,
    };
    expect(designAssetViewSchema.parse(processing)).toEqual(processing);
    expect(designAssetViewSchema.safeParse({ ...readyAsset, status: 'done' }).success).toBe(false);
  });

  it('hand out one presigned PUT with its signed headers', () => {
    const response = {
      assetId,
      uploadUrl:
        'https://acc.r2.cloudflarestorage.com/media/designs/p/a/original?X-Amz-Signature=s',
      headers: { 'Content-Type': 'image/png' },
      expiresAt: at,
    };
    expect(createDesignAssetResponseSchema.parse(response)).toEqual(response);
  });
});

describe('shares and share meta with designs', () => {
  const target = { type: 'folder', folderId: id } as const;

  it('take a designId on create (null by default) and patch', () => {
    expect(createShareBodySchema.parse({ target }).designId).toBeNull();
    expect(createShareBodySchema.parse({ target, designId: id }).designId).toBe(id);
    expect(createShareBodySchema.safeParse({ target, designId: 'default' }).success).toBe(false);
    expect(updateShareBodySchema.parse({ designId: id })).toEqual({ designId: id });
    expect(updateShareBodySchema.parse({ designId: null })).toEqual({ designId: null });
    expect(updateShareBodySchema.safeParse({}).success).toBe(false);
  });

  it("report the share's designId to its owner", () => {
    expect(ownerShareSchema.shape.designId.safeParse(null).success).toBe(true);
    expect(ownerShareSchema.shape.designId.safeParse(id).success).toBe(true);
    expect(ownerShareSchema.shape.designId.safeParse(undefined).success).toBe(false);
  });

  it('give the share page the design document and its ready images only', () => {
    const shape = shareMetaResponseSchema.shape;
    expect(shape.design.safeParse(null).success).toBe(true);
    expect(shape.design.safeParse(undefined).success).toBe(false);
    const meta = {
      doc,
      assets: { [assetId]: { url: readyAsset.url, width: 1200, height: 400 } },
    };
    expect(shareMetaDesignSchema.parse(meta)).toEqual(meta);
    // Exactly { doc, assets }: images carry only url, width and height.
    expect(
      shareMetaDesignSchema.parse({ ...meta, assets: { [assetId]: readyAsset } }).assets[assetId],
    ).toEqual({ url: readyAsset.url, width: 1200, height: 400 });
    expect(
      shareMetaDesignSchema.safeParse({
        ...meta,
        assets: { [assetId]: { url: null, width: 1, height: 1 } },
      }).success,
    ).toBe(false);
    expect(
      shareMetaDesignSchema.safeParse({ doc: { ...doc, elements: [] }, assets: {} }).success,
    ).toBe(false);
    expect(designDocSchema.parse(doc)).toEqual(doc);
  });
});
