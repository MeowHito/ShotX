import {
  blankDesignDoc,
  checkDesignDocLimits,
  type CreateDesignAssetBody,
  type CreateDesignBody,
  DESIGN_ROUTES,
  type Design,
  type DesignAssetMap,
  type DesignAssetView,
  type DesignDoc,
  type DesignLimits,
  type DesignSummary,
  designAssetFileType,
  designDocAssetIds,
  designTemplateDoc,
  type RouteContract,
  type UpdateDesignBody,
} from '@shotx/shared';
import { type FakeApi, Fail, MEDIA, NOW } from './fake-api';
import { NOT_HANDLED } from './fake-share-api';

/**
 * Design routes of the fake API (ADR 0013): designs with optimistic revisions, the default flag,
 * and design images uploaded with one presigned PUT to a fake bucket (STORAGE_ORIGIN), completed,
 * then `ready` after `pollsUntilReady` polls of GET /designs/assets/:id.
 */

/** Origin of the fake presigned PUT URLs (not the API: the browser PUTs there directly). */
export const STORAGE_ORIGIN = 'https://storage.example.com';

interface AssetRow {
  view: DesignAssetView;
  /** Bytes the fake bucket received for it (null before the PUT). */
  putBytes: number | null;
  polls: number;
}

export class FakeDesigns {
  designs = new Map<string, Design>();
  assets = new Map<string, AssetRow>();
  limits: DesignLimits = {
    maxDesigns: 50,
    maxElements: 60,
    docMaxBytes: 65536,
    assetMaxBytes: 15 * 1024 * 1024,
  };
  /** Polls of GET /designs/assets/:id a completed asset stays `processing`. */
  pollsUntilReady = 1;
  /** Width and height the fake worker gives every image. */
  imageSize = { width: 800, height: 400 };
  /** Every PUT the fake bucket received. */
  puts: { assetId: string; size: number; contentType: string | null }[] = [];
  private clock = 0;

  /** A fresh timestamp (each later than the last, so "most recently updated" is well defined). */
  private now(): string {
    this.clock += 1;
    return new Date(Date.parse(NOW) + this.clock * 1000).toISOString();
  }

  /** Seeds a design (the doc defaults to the blank one). */
  add(name: string, doc: DesignDoc = blankDesignDoc(), extra: Partial<Design> = {}): Design {
    const at = this.now();
    const design: Design = {
      id: crypto.randomUUID(),
      name,
      isDefault: false,
      revision: 1,
      doc,
      assets: {},
      createdAt: at,
      updatedAt: at,
      ...extra,
    };
    if (design.isDefault) for (const d of this.designs.values()) d.isDefault = false;
    this.designs.set(design.id, design);
    design.assets = this.assetMap(doc);
    return design;
  }

  /** Seeds a design image (ready unless a status is given). */
  addAsset(status: DesignAssetView['status'] = 'ready'): DesignAssetView {
    const id = crypto.randomUUID();
    const view: DesignAssetView = {
      id,
      status,
      mime: 'image/png',
      sizeBytes: 1000,
      width: null,
      height: null,
      url: null,
      urlExpiresAt: null,
      createdAt: this.now(),
    };
    const row = { view, putBytes: 1000, polls: 0 };
    this.assets.set(id, row);
    if (status === 'ready') this.makeReady(row);
    return view;
  }

  private makeReady(row: AssetRow) {
    row.view = {
      ...row.view,
      status: 'ready',
      width: this.imageSize.width,
      height: this.imageSize.height,
      url: `${MEDIA}/designs/p/${row.view.id}/web.webp?Signature=x`,
      urlExpiresAt: '2099-01-01T00:00:00.000Z',
    };
  }

  assetMap(doc: DesignDoc): DesignAssetMap {
    const map: DesignAssetMap = {};
    for (const id of designDocAssetIds(doc)) {
      const row = this.assets.get(id);
      if (row !== undefined) map[id] = row.view;
    }
    return map;
  }

  /** Checks a document like the api: limits, then asset ownership. */
  private check(doc: DesignDoc) {
    const violation = checkDesignDocLimits(doc, {
      maxElements: this.limits.maxElements,
      docMaxBytes: this.limits.docMaxBytes,
    });
    if (violation !== null) throw new Fail('DESIGN_DOC_TOO_LARGE', violation);
    const missing = designDocAssetIds(doc).filter((id) => !this.assets.has(id));
    if (missing.length > 0) throw new Fail('DESIGN_ASSET_NOT_FOUND', { assetIds: missing });
  }

  private designOrFail(id: string | undefined): Design {
    const design = this.designs.get(id ?? '');
    if (design === undefined) throw new Fail('NOT_FOUND');
    return design;
  }

  /**
   * The fake bucket: answers presigned PUTs to STORAGE_ORIGIN (pass it as the editor's storage
   * fetch). Anything else is a 404.
   */
  storageFetch: typeof fetch = (input, init) => {
    const href = input instanceof Request ? input.url : input.toString();
    const url = new URL(href);
    const assetId = /^\/designs\/[^/]+\/([^/]+)\/original$/.exec(url.pathname)?.[1];
    const row = assetId === undefined ? undefined : this.assets.get(assetId);
    if (url.origin !== STORAGE_ORIGIN || init?.method !== 'PUT' || row === undefined) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const size = init.body instanceof Blob ? init.body.size : 0;
    const headers = new Headers(init.headers);
    row.putBytes = size;
    this.puts.push({ assetId: row.view.id, size, contentType: headers.get('content-type') });
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  handle(
    route: RouteContract,
    params: Record<string, string>,
    query: unknown,
    body: unknown,
  ): unknown {
    switch (route) {
      case DESIGN_ROUTES.list: {
        const items: DesignSummary[] = [...this.designs.values()]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(({ assets: _assets, ...summary }) => summary);
        const assets: DesignAssetMap = {};
        for (const d of items) Object.assign(assets, this.assetMap(d.doc));
        return { items, assets, limits: this.limits };
      }
      case DESIGN_ROUTES.create: {
        const b = body as CreateDesignBody;
        if (this.designs.size >= this.limits.maxDesigns) {
          throw new Fail('DESIGN_LIMIT_REACHED', { maxDesigns: this.limits.maxDesigns });
        }
        const doc =
          b.templateId !== undefined
            ? designTemplateDoc(b.templateId, b.locale ?? 'th')
            : (b.doc ?? blankDesignDoc());
        this.check(doc);
        return this.add(b.name, doc);
      }
      case DESIGN_ROUTES.get:
        return this.designOrFail(params.id);
      case DESIGN_ROUTES.update: {
        const design = this.designOrFail(params.id);
        const b = body as UpdateDesignBody;
        if (b.revision !== design.revision) {
          throw new Fail('DESIGN_REVISION_CONFLICT', { currentRevision: design.revision });
        }
        this.check(b.doc);
        const next: Design = {
          ...design,
          name: b.name,
          doc: b.doc,
          revision: design.revision + 1,
          assets: this.assetMap(b.doc),
          updatedAt: this.now(),
        };
        this.designs.set(design.id, next);
        return next;
      }
      case DESIGN_ROUTES.delete: {
        const design = this.designOrFail(params.id);
        this.designs.delete(design.id);
        return undefined;
      }
      case DESIGN_ROUTES.setDefault: {
        const design = this.designOrFail(params.id);
        for (const d of this.designs.values()) d.isDefault = d.id === design.id;
        return undefined;
      }
      case DESIGN_ROUTES.clearDefault: {
        const design = this.designOrFail(params.id);
        design.isDefault = false;
        return undefined;
      }
      case DESIGN_ROUTES.createAsset: {
        const b = body as CreateDesignAssetBody;
        if (designAssetFileType(b.fileName, b.mime) === null) {
          throw new Fail('UNSUPPORTED_FILE_TYPE', { extension: null, hint: null });
        }
        if (b.sizeBytes > this.limits.assetMaxBytes) {
          throw new Fail('FILE_TOO_LARGE', { maxBytes: this.limits.assetMaxBytes });
        }
        const id = crypto.randomUUID();
        this.assets.set(id, {
          view: {
            id,
            status: 'uploading',
            mime: b.mime,
            sizeBytes: b.sizeBytes,
            width: null,
            height: null,
            url: null,
            urlExpiresAt: null,
            createdAt: this.now(),
          },
          putBytes: null,
          polls: 0,
        });
        return {
          assetId: id,
          uploadUrl: `${STORAGE_ORIGIN}/designs/p/${id}/original?X-Amz-Signature=s`,
          headers: { 'content-type': b.mime },
          expiresAt: '2099-01-01T00:00:00.000Z',
        };
      }
      case DESIGN_ROUTES.completeAsset: {
        const row = this.assets.get(params.id ?? '');
        if (row === undefined) throw new Fail('NOT_FOUND');
        if (row.view.status === 'failed') throw new Fail('CONFLICT');
        if (row.view.status === 'uploading') {
          if (row.putBytes === null) throw new Fail('CONFLICT');
          row.view = { ...row.view, status: 'processing' };
        }
        return row.view;
      }
      case DESIGN_ROUTES.getAsset: {
        const row = this.assets.get(params.id ?? '');
        if (row === undefined) throw new Fail('NOT_FOUND');
        if (row.view.status === 'processing') {
          row.polls += 1;
          if (row.polls >= this.pollsUntilReady) this.makeReady(row);
        }
        return row.view;
      }
      case DESIGN_ROUTES.listAssets: {
        const q = query as { limit?: number };
        const items = [...this.assets.values()]
          .map((r) => r.view)
          .filter((v) => v.status !== 'failed')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, q.limit ?? 60);
        return { items, nextCursor: null };
      }
      default:
        return NOT_HANDLED;
    }
  }
}

/** The design routes of the fake API (NOT_HANDLED for every other route). */
export function handleDesigns(
  api: FakeApi,
  route: RouteContract,
  params: Record<string, string>,
  query: unknown,
  body: unknown,
): unknown {
  return api.designs.handle(route, params, query, body);
}
