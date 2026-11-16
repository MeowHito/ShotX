import { randomUUID } from 'node:crypto';
import { activityEvents, designAssets, shareDesigns, shares } from '@shotx/db';
import {
  apiPath,
  blankDesignDoc,
  createDesignAssetResponseSchema,
  DESIGN_ROUTES as D,
  DESIGN_TEMPLATE_IDS,
  designAssetViewSchema,
  type DesignDoc,
  type DesignElement,
  designSchema,
  designTemplateDoc,
  ERROR_HTTP_STATUS,
  listDesignAssetsResponseSchema,
  listDesignsResponseSchema,
  ownerShareSchema,
  PUBLIC_SHARE_ROUTES as P,
  SHARE_ROUTES as S,
  shareItemsResponseSchema,
  shareMetaResponseSchema,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { OFFLINE_ACCOUNTS_ENV } from '../testing/fakes';
import { insertReadyFile } from '../testing/seed';
import { TestApi } from '../testing/harness';

// --- documents ----------------------------------------------------------------------------------

const box = { x: 20, y: 20, w: 200, h: 60, rotation: 0, opacity: 1, locked: false, hidden: false };

function text(id: string, value: string): DesignElement {
  return {
    ...box,
    id,
    type: 'text',
    text: value,
    font: 'kanit',
    size: 20,
    weight: 400,
    color: '#111827',
    align: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    italic: false,
    uppercase: false,
    shadow: null,
  };
}

function shape(id: string): DesignElement {
  return {
    ...box,
    id,
    type: 'shape',
    shape: 'rect',
    fill: '#ffffff',
    stroke: null,
    strokeWidth: 0,
    radius: 12,
    glass: 0,
  };
}

function image(id: string, assetId: string): DesignElement {
  return { ...box, id, type: 'image', assetId, fit: 'contain', radius: 0, flipX: false };
}

/** The blank design plus `extra` elements on top. */
function docWith(...extra: DesignElement[]): DesignDoc {
  const blank = blankDesignDoc();
  return { ...blank, elements: [...blank.elements, ...extra] };
}

/** An image background on `bgAssetId` plus image elements on `assetIds`. */
function docWithImages(bgAssetId: string, ...assetIds: string[]): DesignDoc {
  return {
    ...docWith(...assetIds.map((id, i) => image(`img${i}`, id))),
    background: { type: 'image', assetId: bgAssetId, blur: 4, dim: 0.2, color: '#000000' },
  };
}

const THAI_500 = 'ก'.repeat(500);

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`share page designs (ADR 0013) on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db);
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    const createDesign = (token: string, body: unknown, on: TestApi = api) =>
      on.request('POST', apiPath(D.create), { token, body });
    const getDesign = (token: string, id: string) =>
      api.request('GET', apiPath(D.get, { id }), { token });
    const putDesign = (token: string, id: string, body: unknown, on: TestApi = api) =>
      on.request('PUT', apiPath(D.update, { id }), { token, body });
    const createAsset = (token: string, body: unknown, on: TestApi = api) =>
      on.request('POST', apiPath(D.createAsset), { token, body });
    const completeAsset = (token: string, id: string, on: TestApi = api) =>
      on.request('POST', apiPath(D.completeAsset, { id }), { token });

    async function newDesign(token: string, body: Record<string, unknown> = {}) {
      const res = await createDesign(token, { name: 'Event card', ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return designSchema.parse(res.body);
    }

    async function newAsset(
      owner: { id: string; token: string },
      body: Partial<{ fileName: string; mime: string; sizeBytes: number }> = {},
      on: TestApi = api,
    ) {
      const res = await createAsset(
        owner.token,
        { fileName: 'logo.png', mime: 'image/png', sizeBytes: 2048, ...body },
        on,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return createDesignAssetResponseSchema.parse(res.body);
    }

    /** What the worker's design.asset job leaves: verified, web.webp written, ready. */
    async function markReady(assetId: string, width = 800, height = 400): Promise<void> {
      await api.db
        .update(designAssets)
        .set({ status: 'ready', width, height, verifiedAt: api.clock.now() })
        .where(eq(designAssets.id, assetId));
    }

    describe('designs: create, read, list', () => {
      it('creates blank, from a template in a locale, and from a document', async () => {
        const owner = await api.photographer();
        const blank = await newDesign(owner.token, { name: '  Blank  ' });
        // ADR 0028: the owner's first design becomes the default; later ones don't.
        expect(blank).toMatchObject({
          name: 'Blank',
          isDefault: true,
          revision: 1,
          doc: blankDesignDoc(),
          assets: {},
        });
        const templateId = DESIGN_TEMPLATE_IDS[1] ?? DESIGN_TEMPLATE_IDS[0];
        const fromTemplate = await newDesign(owner.token, { templateId, locale: 'en' });
        expect(fromTemplate.isDefault).toBe(false);
        expect(fromTemplate.doc).toEqual(designTemplateDoc(templateId, 'en'));
        const thai = await newDesign(owner.token, { templateId });
        expect(thai.doc).toEqual(designTemplateDoc(templateId, 'th'));
        const doc = docWith(text('title', 'งานวิ่ง 2026'));
        const fromDoc = await newDesign(owner.token, { doc });
        expect(fromDoc.doc).toEqual(doc);

        const both = await createDesign(owner.token, { name: 'x', templateId, doc });
        expect(both).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
        // A document the schema refuses (two face icons) never reaches the database.
        const two = docWith({
          ...box,
          id: 'face2',
          type: 'faceIcon',
          color: '#000000',
          strokeWidth: 4,
        });
        expect((await createDesign(owner.token, { name: 'x', doc: two })).status).toBe(400);

        const fetched = await getDesign(owner.token, fromDoc.id);
        expect(designSchema.parse(fetched.body)).toEqual(fromDoc);
      });

      it('lists only the caller’s designs, newest change first, with the limits', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const a = await newDesign(owner.token, { name: 'A' });
        api.clock.advance(1000);
        const b = await newDesign(owner.token, { name: 'B' });
        await newDesign(other.token, { name: 'Theirs' });
        api.clock.advance(1000);
        // Saving A makes it the most recently updated.
        expect(
          (await putDesign(owner.token, a.id, { name: 'A2', doc: a.doc, revision: 1 })).status,
        ).toBe(200);
        const res = await api.request('GET', apiPath(D.list), { token: owner.token });
        const list = listDesignsResponseSchema.parse(res.body);
        expect(list.items.map((d) => d.id)).toEqual([a.id, b.id]);
        expect(list.items[0]).toMatchObject({ name: 'A2', revision: 2 });
        expect(list.limits).toEqual({
          maxDesigns: 50,
          maxElements: 60,
          docMaxBytes: 65536,
          assetMaxBytes: 15 * 1024 * 1024,
        });
      });

      it('answers NOT_FOUND for another photographer’s design on every route', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const design = await newDesign(owner.token);
        const id = design.id;
        const attempts = [
          getDesign(other.token, id),
          putDesign(other.token, id, { name: 'Mine now', doc: design.doc, revision: 1 }),
          api.request('DELETE', apiPath(D.delete, { id }), { token: other.token }),
          api.request('POST', apiPath(D.setDefault, { id }), { token: other.token }),
          api.request('DELETE', apiPath(D.clearDefault, { id }), { token: other.token }),
        ];
        for (const res of await Promise.all(attempts)) {
          expect(res).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
        }
        const [row] = await api.db.select().from(shareDesigns).where(eq(shareDesigns.id, id));
        expect(row).toMatchObject({ name: 'Event card', revision: 1, isDefault: true });
        // Unknown ids too; and `assets` is never read as an id.
        expect((await getDesign(owner.token, randomUUID())).status).toBe(404);
        expect(
          (await api.request('GET', apiPath(D.listAssets), { token: owner.token })).status,
        ).toBe(200);
      });

      it('is photographer only', async () => {
        const viewer = await api.viewer();
        for (const [method, path] of [
          ['GET', apiPath(D.list)],
          ['POST', apiPath(D.create)],
          ['GET', apiPath(D.listAssets)],
          ['POST', apiPath(D.createAsset)],
        ] as const) {
          const body = method === 'POST' ? { body: {} } : {};
          expect(
            (await api.request(method, path, { token: viewer.token, ...body })).body,
          ).toMatchObject({ code: 'FORBIDDEN' });
          expect((await api.request(method, path, body)).status).toBe(401);
        }
      });
    });

    describe('designs: save with revision', () => {
      it('saves with the current revision and refuses a stale one, changing nothing', async () => {
        const owner = await api.photographer();
        const design = await newDesign(owner.token);
        const doc2 = docWith(text('t', 'แก้ไขครั้งที่ 1'));
        const saved = await putDesign(owner.token, design.id, {
          name: 'Saved',
          doc: doc2,
          revision: 1,
        });
        expect(saved.status).toBe(200);
        expect(designSchema.parse(saved.body)).toMatchObject({
          name: 'Saved',
          revision: 2,
          doc: doc2,
          // The owner's first design (ADR 0028); a save never changes it.
          isDefault: true,
        });

        const stale = await putDesign(owner.token, design.id, {
          name: 'Other tab',
          doc: blankDesignDoc(),
          revision: 1,
        });
        expect(stale).toMatchObject({
          status: 409,
          body: { code: 'DESIGN_REVISION_CONFLICT', details: { currentRevision: 2 } },
        });
        const [row] = await api.db
          .select()
          .from(shareDesigns)
          .where(eq(shareDesigns.id, design.id));
        expect(row).toMatchObject({ name: 'Saved', revision: 2, doc: doc2 });

        // A revision from the future is just as stale.
        expect(
          (await putDesign(owner.token, design.id, { name: 'x', doc: doc2, revision: 9 })).body,
        ).toMatchObject({ code: 'DESIGN_REVISION_CONFLICT', details: { currentRevision: 2 } });
        // Sequential saves keep counting.
        const third = await putDesign(owner.token, design.id, {
          name: 'Saved',
          doc: doc2,
          revision: 2,
        });
        expect(third.body).toMatchObject({ revision: 3 });
      });

      it('does not change the default flag on save', async () => {
        const owner = await api.photographer();
        const design = await newDesign(owner.token);
        await api.request('POST', apiPath(D.setDefault, { id: design.id }), {
          token: owner.token,
        });
        const saved = await putDesign(owner.token, design.id, {
          name: 'Still default',
          doc: design.doc,
          revision: 1,
        });
        expect(saved.body).toMatchObject({ isDefault: true, revision: 2 });
      });
    });

    describe('designs: asset references', () => {
      it('accepts the caller’s images in any status and returns them in the asset map', async () => {
        const owner = await api.photographer();
        const uploading = await newAsset(owner);
        const ready = await newAsset(owner, { fileName: 'bg.jpg', mime: 'image/jpeg' });
        await markReady(ready.assetId, 1280, 720);
        const doc = docWithImages(ready.assetId, uploading.assetId);
        const design = await newDesign(owner.token, { doc });
        expect(Object.keys(design.assets).sort()).toEqual(
          [ready.assetId, uploading.assetId].sort(),
        );
        expect(design.assets[uploading.assetId]).toMatchObject({
          status: 'uploading',
          url: null,
          urlExpiresAt: null,
          width: null,
        });
        const readyView = design.assets[ready.assetId];
        expect(readyView).toMatchObject({ status: 'ready', width: 1280, height: 720 });
        expect(readyView?.url).toMatch(
          new RegExp(
            `^https://photos\\.example\\.com/media/designs/${owner.id}/${ready.assetId}/web\\.webp\\?`,
          ),
        );
        // Never the original, never a storage URL.
        expect(JSON.stringify(design)).not.toContain('/original');
        expect(JSON.stringify(design)).not.toContain('amazonaws.com');
        // GET and the list carry the same map.
        expect((await getDesign(owner.token, design.id)).body).toMatchObject({
          assets: { [ready.assetId]: { status: 'ready' } },
        });
        const list = listDesignsResponseSchema.parse(
          (await api.request('GET', apiPath(D.list), { token: owner.token })).body,
        );
        expect(Object.keys(list.assets).sort()).toEqual([ready.assetId, uploading.assetId].sort());
      });

      it('refuses unknown, foreign and purged images with every missing id, in order', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const mine = await newAsset(owner);
        const purged = await newAsset(owner);
        await api.db
          .update(designAssets)
          .set({ purgeRequestedAt: api.clock.now() })
          .where(eq(designAssets.id, purged.assetId));
        const theirs = await newAsset(other);
        const unknown = randomUUID();

        const doc = docWithImages(theirs.assetId, mine.assetId, unknown, purged.assetId);
        const created = await createDesign(owner.token, { name: 'x', doc });
        expect(created).toMatchObject({
          status: ERROR_HTTP_STATUS.DESIGN_ASSET_NOT_FOUND,
          body: {
            code: 'DESIGN_ASSET_NOT_FOUND',
            details: { assetIds: [theirs.assetId, unknown, purged.assetId] },
          },
        });

        const design = await newDesign(owner.token);
        const saved = await putDesign(owner.token, design.id, {
          name: 'x',
          doc: docWithImages(mine.assetId, theirs.assetId),
          revision: 1,
        });
        expect(saved.body).toMatchObject({
          code: 'DESIGN_ASSET_NOT_FOUND',
          details: { assetIds: [theirs.assetId] },
        });
        const [row] = await api.db
          .select()
          .from(shareDesigns)
          .where(eq(shareDesigns.id, design.id));
        expect(row).toMatchObject({ revision: 1, doc: blankDesignDoc() });
        // Nothing was created by the refused POST either.
        const all = await api.db
          .select()
          .from(shareDesigns)
          .where(eq(shareDesigns.ownerId, owner.id));
        expect(all).toHaveLength(1);
      });
    });

    describe('designs: default and delete', () => {
      it('switches the default in one step, idempotently, and clears it', async () => {
        const owner = await api.photographer();
        const a = await newDesign(owner.token, { name: 'A' });
        const b = await newDesign(owner.token, { name: 'B' });
        const setDefault = (id: string) =>
          api.request('POST', apiPath(D.setDefault, { id }), { token: owner.token });
        const clearDefault = (id: string) =>
          api.request('DELETE', apiPath(D.clearDefault, { id }), { token: owner.token });
        const defaults = async () =>
          (
            await api.db
              .select({ id: shareDesigns.id, isDefault: shareDesigns.isDefault })
              .from(shareDesigns)
              .where(eq(shareDesigns.ownerId, owner.id))
          )
            .filter((d) => d.isDefault)
            .map((d) => d.id);

        expect((await setDefault(a.id)).status).toBe(204);
        expect(await defaults()).toEqual([a.id]);
        expect((await setDefault(b.id)).status).toBe(204);
        expect(await defaults()).toEqual([b.id]);
        expect((await setDefault(b.id)).status).toBe(204);
        expect(await defaults()).toEqual([b.id]);
        // Clearing a design that isn't the default is a no-op.
        expect((await clearDefault(a.id)).status).toBe(204);
        expect(await defaults()).toEqual([b.id]);
        expect((await clearDefault(b.id)).status).toBe(204);
        expect(await defaults()).toEqual([]);
        // Concurrent switches still leave exactly one.
        const results = await Promise.all([setDefault(a.id), setDefault(b.id), setDefault(a.id)]);
        expect(results.map((r) => r.status)).toEqual([204, 204, 204]);
        expect(await defaults()).toHaveLength(1);
        // Another owner's default is untouched by all of this.
        const other = await api.photographer();
        const theirs = await newDesign(other.token);
        await api.request('POST', apiPath(D.setDefault, { id: theirs.id }), {
          token: other.token,
        });
        await setDefault(b.id);
        const [their] = await api.db
          .select()
          .from(shareDesigns)
          .where(eq(shareDesigns.id, theirs.id));
        expect(their?.isDefault).toBe(true);
      });

      it('hard-deletes; shares using it fall back to no design, images stay', async () => {
        const owner = await api.photographer();
        const asset = await newAsset(owner);
        const design = await newDesign(owner.token, { doc: docWithImages(asset.assetId) });
        await api.request('POST', apiPath(D.setDefault, { id: design.id }), {
          token: owner.token,
        });
        const folder = await api.folder(owner.id);
        const created = await api.request('POST', apiPath(S.create), {
          token: owner.token,
          body: { target: { type: 'folder', folderId: folder.id }, designId: design.id },
        });
        const share = ownerShareSchema.parse(created.body);
        expect(share.designId).toBe(design.id);

        const del = await api.request('DELETE', apiPath(D.delete, { id: design.id }), {
          token: owner.token,
        });
        expect(del.status).toBe(204);
        expect((await getDesign(owner.token, design.id)).status).toBe(404);
        expect(
          (
            await api.request('DELETE', apiPath(D.delete, { id: design.id }), {
              token: owner.token,
            })
          ).status,
        ).toBe(404);
        const after = await api.request('GET', apiPath(S.get, { id: share.id }), {
          token: owner.token,
        });
        expect(ownerShareSchema.parse(after.body).designId).toBeNull();
        const [assetRow] = await api.db
          .select()
          .from(designAssets)
          .where(eq(designAssets.id, asset.assetId));
        expect(assetRow?.purgeRequestedAt).toBeNull();
      });
    });

    describe('design images', () => {
      it('reserves the bytes, stores the row and presigns one PUT with signed headers', async () => {
        const owner = await api.photographer();
        const before = await api.usage(owner.id);
        const res = await newAsset(owner, {
          fileName: 'Logo บริษัท.PNG',
          mime: 'image/png; charset=binary',
          sizeBytes: 123_456,
        });
        expect(res.headers).toEqual({ 'Content-Type': 'image/png' });
        expect(res.expiresAt).toBe(new Date(api.clock.now().getTime() + 3600 * 1000).toISOString());
        const key = `designs/${owner.id}/${res.assetId}/original`;
        expect(
          res.uploadUrl.startsWith(
            `https://shotx-test-media.s3.ap-southeast-1.amazonaws.com/${key}?`,
          ),
        ).toBe(true);
        const url = new URL(res.uploadUrl);
        expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
        expect(url.searchParams.get('x-test-content-length')).toBe('123456');
        expect(url.searchParams.get('x-test-content-type')).toBe('image/png');
        expect(api.storage.calls).toContain(`presign-put ${key}`);
        const after = await api.usage(owner.id);
        expect(after.reservedBytes - before.reservedBytes).toBe(123_456);
        expect(after.usedBytes).toBe(before.usedBytes);
        const [row] = await api.db
          .select()
          .from(designAssets)
          .where(eq(designAssets.id, res.assetId));
        expect(row).toMatchObject({
          ownerId: owner.id,
          mime: 'image/png',
          sizeBytes: 123_456,
          status: 'uploading',
          uploadExpiresAt: new Date(res.expiresAt),
          queuedAt: null,
        });
        // The file name is only checked, never stored.
        expect(JSON.stringify(row)).not.toContain('Logo');
      });

      it('refuses other types and oversized images before reserving anything', async () => {
        const owner = await api.photographer();
        for (const [fileName, mime] of [
          ['logo.svg', 'image/svg+xml'],
          ['clip.mp4', 'video/mp4'],
          ['photo.heic', 'image/heic'],
          ['logo.png', 'image/jpeg'],
          ['noext', 'image/png'],
        ] as const) {
          const res = await createAsset(owner.token, { fileName, mime, sizeBytes: 100 });
          expect(res.status, fileName).toBe(ERROR_HTTP_STATUS.UNSUPPORTED_FILE_TYPE);
          expect(res.body, fileName).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
        }
        expect(
          (await createAsset(owner.token, { fileName: 'a.heic', mime: 'image/heic', sizeBytes: 1 }))
            .body,
        ).toMatchObject({ details: { extension: 'heic', hint: 'heic' } });
        const big = await createAsset(owner.token, {
          fileName: 'big.jpg',
          mime: 'image/jpeg',
          sizeBytes: 15 * 1024 * 1024 + 1,
        });
        expect(big).toMatchObject({
          status: ERROR_HTTP_STATUS.FILE_TOO_LARGE,
          body: { code: 'FILE_TOO_LARGE', details: { maxBytes: 15 * 1024 * 1024 } },
        });
        expect(await api.usage(owner.id)).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
        expect(
          await api.db.select().from(designAssets).where(eq(designAssets.ownerId, owner.id)),
        ).toEqual([]);
      });

      it('applies the quota and the subscription like uploads when they gate', async () => {
        const small = await api.photographer({ quotaBytes: 1000 });
        expect(
          (
            await createAsset(small.token, {
              fileName: 'a.png',
              mime: 'image/png',
              sizeBytes: 1001,
            })
          ).body,
        ).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { requestedBytes: 1001 } });
        await newAsset(small, { sizeBytes: 1000 });
        expect(await api.usage(small.id)).toMatchObject({ reservedBytes: 1000 });
        const lapsed = await api.photographer({ status: 'expired' });
        expect(
          (await createAsset(lapsed.token, { fileName: 'a.png', mime: 'image/png', sizeBytes: 1 }))
            .body,
        ).toMatchObject({
          code: 'SUBSCRIPTION_INACTIVE',
        });
      });

      it('completes once into processing; retries, expiry, failure and ownership', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const asset = await newAsset(owner);
        api.storage.putObject(`designs/${owner.id}/${asset.assetId}/original`, 2048, 'image/png');
        expect((await completeAsset(other.token, asset.assetId)).status).toBe(404);

        const done = await completeAsset(owner.token, asset.assetId);
        expect(done.status).toBe(200);
        expect(designAssetViewSchema.parse(done.body)).toMatchObject({
          id: asset.assetId,
          status: 'processing',
          url: null,
        });
        const [row] = await api.db
          .select()
          .from(designAssets)
          .where(eq(designAssets.id, asset.assetId));
        expect(row?.queuedAt).toEqual(api.clock.now());
        // QUEUE_BACKEND=sqs here: the api has no media queue (media.sweep sends it).
        expect(api.queue.messages('media')).toEqual([]);
        const again = await completeAsset(owner.token, asset.assetId);
        expect(again.body).toMatchObject({ status: 'processing' });

        const late = await newAsset(owner);
        api.clock.advance(3600 * 1000);
        expect(await completeAsset(owner.token, late.assetId)).toMatchObject({
          status: ERROR_HTTP_STATUS.UPLOAD_EXPIRED,
          body: { code: 'UPLOAD_EXPIRED' },
        });

        const broken = await newAsset(owner);
        await api.db
          .update(designAssets)
          .set({ status: 'failed' })
          .where(eq(designAssets.id, broken.assetId));
        expect((await completeAsset(owner.token, broken.assetId)).body).toMatchObject({
          code: 'CONFLICT',
        });

        await markReady(asset.assetId);
        const ready = await completeAsset(owner.token, asset.assetId);
        expect(ready.body).toMatchObject({ status: 'ready', width: 800, height: 400 });
      });

      it('gets one image with its URL once ready; purged and foreign ones are NOT_FOUND', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const asset = await newAsset(owner);
        const get = (token: string, id: string) =>
          api.request('GET', apiPath(D.getAsset, { id }), { token });
        expect(
          designAssetViewSchema.parse((await get(owner.token, asset.assetId)).body),
        ).toMatchObject({
          status: 'uploading',
          url: null,
          width: null,
          height: null,
          sizeBytes: 2048,
        });
        await markReady(asset.assetId, 640, 480);
        const ready = designAssetViewSchema.parse((await get(owner.token, asset.assetId)).body);
        expect(ready).toMatchObject({ status: 'ready', width: 640, height: 480 });
        expect(ready.url).toContain(`/media/designs/${owner.id}/${asset.assetId}/web.webp?`);
        expect(ready.urlExpiresAt).not.toBeNull();
        expect((await get(other.token, asset.assetId)).status).toBe(404);
        await api.db
          .update(designAssets)
          .set({ purgeRequestedAt: api.clock.now() })
          .where(eq(designAssets.id, asset.assetId));
        expect((await get(owner.token, asset.assetId)).status).toBe(404);
      });

      it('lists the caller’s live images newest first, in pages, without failed ones', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) ids.push((await newAsset(owner)).assetId);
        await newAsset(other);
        const [failed, purged] = [ids[1] ?? '', ids[2] ?? ''];
        await api.db
          .update(designAssets)
          .set({ status: 'failed' })
          .where(eq(designAssets.id, failed));
        await api.db
          .update(designAssets)
          .set({ purgeRequestedAt: api.clock.now() })
          .where(eq(designAssets.id, purged));
        const extra = [(await newAsset(owner)).assetId, (await newAsset(owner)).assetId];
        const expected = [...extra.reverse(), ids[3], ids[0]];

        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 5; page++) {
          const q: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
          const res = await api.request('GET', `${apiPath(D.listAssets)}${q}`, {
            token: owner.token,
          });
          const body = listDesignAssetsResponseSchema.parse(res.body);
          seen.push(...body.items.map((a) => a.id));
          cursor = body.nextCursor;
          if (cursor === null) break;
        }
        expect(seen).toEqual(expected);
        expect(
          (
            await api.request('GET', `${apiPath(D.listAssets)}?cursor=bogus`, {
              token: owner.token,
            })
          ).body,
        ).toMatchObject({ code: 'VALIDATION_FAILED' });
      });
    });

    describe('shares: designId', () => {
      it('takes only the caller’s own design on create and patch', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const mine = await newDesign(owner.token);
        const theirs = await newDesign(other.token);
        const folder = await api.folder(owner.id);
        const target = { type: 'folder', folderId: folder.id };

        for (const designId of [theirs.id, randomUUID()]) {
          const res = await api.request('POST', apiPath(S.create), {
            token: owner.token,
            body: { target, designId },
          });
          expect(res).toMatchObject({
            status: ERROR_HTTP_STATUS.DESIGN_NOT_FOUND,
            body: { code: 'DESIGN_NOT_FOUND' },
          });
        }
        expect(await api.db.select().from(shares).where(eq(shares.ownerId, owner.id))).toHaveLength(
          0,
        );

        const plain = ownerShareSchema.parse(
          (await api.request('POST', apiPath(S.create), { token: owner.token, body: { target } }))
            .body,
        );
        expect(plain.designId).toBeNull();
        const patch = (body: unknown) =>
          api.request('PATCH', apiPath(S.update, { id: plain.id }), { token: owner.token, body });
        expect(ownerShareSchema.parse((await patch({ designId: mine.id })).body).designId).toBe(
          mine.id,
        );
        expect((await patch({ designId: theirs.id })).body).toMatchObject({
          code: 'DESIGN_NOT_FOUND',
        });
        const [row] = await api.db.select().from(shares).where(eq(shares.id, plain.id));
        expect(row?.designId).toBe(mine.id);
        // Other settings leave it alone; null clears it.
        expect(ownerShareSchema.parse((await patch({ allowDownload: false })).body).designId).toBe(
          mine.id,
        );
        expect(ownerShareSchema.parse((await patch({ designId: null })).body).designId).toBeNull();
        const list = await api.request('GET', apiPath(S.list), { token: owner.token });
        expect(list.body).toMatchObject({ items: [{ id: plain.id, designId: null }] });
      });
    });

    describe('public share meta: design', () => {
      const meta = (token: string) => apiPath(P.meta, { token });

      it('ADR 0019: a design with "show photos" off serves a gallery folder share as face_only', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        await insertReadyFile(api.db, owner.id, { name: 'a.jpg', folderId: folder.id });
        const share = await api.share(owner.id, { folderId: folder.id });
        const browser = api.browser();
        const read = async () => {
          const m = shareMetaResponseSchema.parse(
            (await browser.request('GET', meta(share.token))).body,
          );
          const page = shareItemsResponseSchema.parse(
            (await browser.request('GET', apiPath(P.items, { token: share.token }))).body,
          );
          return { mode: m.mode, items: page.items.length, design: m.design };
        };
        expect(await read()).toMatchObject({ mode: 'gallery', items: 1, design: null });

        // Show photos on (absent or true): unchanged, the photos are browsable under the card.
        const shown = await newDesign(owner.token, { doc: docWith() });
        const patch = (body: unknown) =>
          api.request('PATCH', apiPath(S.update, { id: share.id }), { token: owner.token, body });
        expect((await patch({ designId: shown.id })).status).toBe(200);
        expect(await read()).toMatchObject({ mode: 'gallery', items: 1 });
        const explicit = await putDesign(owner.token, shown.id, {
          name: shown.name,
          revision: shown.revision,
          doc: { ...docWith(), showPhotos: true },
        });
        expect(explicit.status, JSON.stringify(explicit.body)).toBe(200);
        expect(await read()).toMatchObject({ mode: 'gallery', items: 1 });

        // Off: face scan only, enforced by the api (no items without a scan result).
        const hidden = await newDesign(owner.token, {
          name: 'Scan only',
          doc: { ...docWith(), showPhotos: false },
        });
        expect((await patch({ designId: hidden.id })).status).toBe(200);
        const off = await read();
        expect(off).toMatchObject({ mode: 'face_only', items: 0 });
        expect(off.design?.doc.showPhotos).toBe(false);
        // The share row keeps its own mode; the owner still sees gallery.
        const [row] = await api.db.select().from(shares).where(eq(shares.id, share.id));
        expect(row?.mode).toBe('gallery');

        // The same link back to the plain layout (or another design) shows the photos again.
        expect((await patch({ designId: null })).status).toBe(200);
        expect(await read()).toMatchObject({ mode: 'gallery', items: 1, design: null });

        // A default design that hides photos is never applied at view time (ADR 0013).
        await api.request('POST', apiPath(D.setDefault, { id: hidden.id }), { token: owner.token });
        expect(await read()).toMatchObject({ mode: 'gallery', items: 1 });
      });

      it('uses the share’s own design only: a default set later never changes existing shares', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const plain = await api.share(owner.id, { folderId: folder.id });
        const browser = api.browser();
        const read = async (token: string) =>
          shareMetaResponseSchema.parse((await browser.request('GET', meta(token))).body).design;

        expect(await read(plain.token)).toBeNull();

        const fallback = await newDesign(owner.token, {
          name: 'Default',
          doc: docWith(text('t', 'ค่าเริ่มต้น')),
        });
        await api.request('POST', apiPath(D.setDefault, { id: fallback.id }), {
          token: owner.token,
        });
        // The default is not applied at view time (ADR 0013 amendment).
        expect(await read(plain.token)).toBeNull();

        const chosen = await newDesign(owner.token, {
          name: 'Chosen',
          doc: docWith(text('t', 'เลือกเอง')),
        });
        const withDesign = await api.share(owner.id, { folderId: folder.id });
        await api.db
          .update(shares)
          .set({ designId: chosen.id })
          .where(eq(shares.id, withDesign.id));
        expect((await read(withDesign.token))?.doc).toEqual(chosen.doc);
        expect(await read(plain.token)).toBeNull();
      });

      it('signs only the owner’s ready images and writes no activity event', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const ready = await newAsset(owner);
        await markReady(ready.assetId, 1000, 500);
        const pending = await newAsset(owner);
        const failed = await newAsset(owner);
        await api.db
          .update(designAssets)
          .set({ status: 'failed' })
          .where(eq(designAssets.id, failed.assetId));
        const theirs = await newAsset(other);
        await markReady(theirs.assetId);
        // A document naming a foreign image can't be saved through the API; written directly to
        // check the read path filters by owner as well.
        const [design] = await api.db
          .insert(shareDesigns)
          .values({
            ownerId: owner.id,
            name: 'Direct',
            doc: docWithImages(ready.assetId, pending.assetId, failed.assetId, theirs.assetId),
            isDefault: true,
          })
          .returning();
        expect(design).toBeDefined();
        const folder = await api.folder(owner.id);
        const share = await api.share(owner.id, { folderId: folder.id });
        await api.db
          .update(shares)
          .set({ designId: design?.id ?? null })
          .where(eq(shares.id, share.id));
        const eventsBefore = await api.db
          .select()
          .from(activityEvents)
          .where(eq(activityEvents.shareId, share.id));

        const res = await api.browser().request('GET', meta(share.token));
        const body = shareMetaResponseSchema.parse(res.body);
        expect(Object.keys(body.design?.assets ?? {})).toEqual([ready.assetId]);
        const signed = body.design?.assets[ready.assetId];
        expect(signed).toMatchObject({ width: 1000, height: 500 });
        expect(signed?.url).toMatch(
          new RegExp(
            `^https://photos\\.example\\.com/media/designs/${owner.id}/${ready.assetId}/web\\.webp\\?`,
          ),
        );
        // The view TTL, like previews.
        const expires = Number(new URL(signed?.url ?? '').searchParams.get('Expires'));
        const ttl = expires - Math.floor(api.clock.now().getTime() / 1000);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(
          api.config.share.signedUrlTtlSeconds.view + api.config.share.signedUrlExpiryBucketSeconds,
        );
        const eventsAfter = await api.db
          .select()
          .from(activityEvents)
          .where(eq(activityEvents.shareId, share.id));
        expect(eventsAfter).toHaveLength(eventsBefore.length);
      });

      it('stays null behind the password and login gates, like details', async () => {
        const owner = await api.photographer();
        const design = await newDesign(owner.token, { doc: docWith(text('t', 'ความลับ')) });
        await api.request('POST', apiPath(D.setDefault, { id: design.id }), {
          token: owner.token,
        });
        const folder = await api.folder(owner.id);
        const locked = await api.share(owner.id, { folderId: folder.id }, { password: 'pin-4321' });
        const useDesign = (shareId: string) =>
          api.db.update(shares).set({ designId: design.id }).where(eq(shares.id, shareId));
        await useDesign(locked.id);
        const browser = api.browser();
        const before = shareMetaResponseSchema.parse(
          (await browser.request('GET', meta(locked.token))).body,
        );
        expect(before.access.locked).toBe(true);
        expect(before.details).toBeNull();
        expect(before.design).toBeNull();
        expect(JSON.stringify(before)).not.toContain('ความลับ');
        const unlocked = await browser.request('POST', apiPath(P.unlock, { token: locked.token }), {
          body: { password: 'pin-4321' },
        });
        expect(unlocked.status).toBe(204);
        const after = shareMetaResponseSchema.parse(
          (await browser.request('GET', meta(locked.token))).body,
        );
        expect(after.design?.doc).toEqual(design.doc);

        const loginOnly = await api.share(
          owner.id,
          { folderId: folder.id },
          { requireLogin: true },
        );
        await useDesign(loginOnly.id);
        const anon = shareMetaResponseSchema.parse(
          (await api.browser().request('GET', meta(loginOnly.token))).body,
        );
        expect(anon.access.loginRequired).toBe(true);
        expect(anon.design).toBeNull();
      });
    });

    describe('limits and body size', () => {
      let tight: TestApi;

      beforeAll(async () => {
        tight = await TestApi.start(database.db, {
          env: {
            ...OFFLINE_ACCOUNTS_ENV,
            QUEUE_BACKEND: 'bullmq',
            DESIGN_MAX_PER_OWNER: '3',
            DESIGN_MAX_ELEMENTS: '20',
            DESIGN_DOC_MAX_BYTES: '8192',
            DESIGN_BODY_MAX_BYTES: '16384',
          },
        });
      }, 120_000);

      afterAll(async () => {
        await tight?.close();
      });

      it('counts designs per owner (DESIGN_LIMIT_REACHED), also under concurrent creates', async () => {
        const owner = await tight.photographer();
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) => createDesign(owner.token, { name: `D${i}` }, tight)),
        );
        expect(results.filter((r) => r.status === 201)).toHaveLength(3);
        for (const res of results.filter((r) => r.status !== 201)) {
          expect(res).toMatchObject({
            status: ERROR_HTTP_STATUS.DESIGN_LIMIT_REACHED,
            body: { code: 'DESIGN_LIMIT_REACHED', details: { maxDesigns: 3 } },
          });
        }
        // Per owner: someone else still can.
        const other = await tight.photographer();
        expect((await createDesign(other.token, { name: 'Mine' }, tight)).status).toBe(201);
        // Deleting one frees a slot.
        const [first] = await tight.db
          .select()
          .from(shareDesigns)
          .where(eq(shareDesigns.ownerId, owner.id));
        await tight.request('DELETE', apiPath(D.delete, { id: first?.id ?? '' }), {
          token: owner.token,
        });
        expect((await createDesign(owner.token, { name: 'Again' }, tight)).status).toBe(201);
      });

      it('refuses documents over the configured elements and bytes (DESIGN_DOC_TOO_LARGE)', async () => {
        const owner = await tight.photographer();
        const many = docWith(...Array.from({ length: 18 }, (_, i) => shape(`s${i}`)));
        expect(many.elements).toHaveLength(21);
        expect(await createDesign(owner.token, { name: 'x', doc: many }, tight)).toMatchObject({
          status: ERROR_HTTP_STATUS.DESIGN_DOC_TOO_LARGE,
          body: {
            code: 'DESIGN_DOC_TOO_LARGE',
            details: { reason: 'elements', max: 20, actual: 21 },
          },
        });
        const heavy = docWith(...Array.from({ length: 5 }, (_, i) => text(`h${i}`, THAI_500)));
        const heavyBytes = Buffer.byteLength(JSON.stringify(heavy));
        expect(heavyBytes).toBeGreaterThan(8192);
        expect(heavyBytes).toBeLessThan(16384 - 1024);
        const created = await createDesign(owner.token, { name: 'x', doc: heavy }, tight);
        expect(created.body).toMatchObject({
          code: 'DESIGN_DOC_TOO_LARGE',
          details: { reason: 'bytes', max: 8192 },
        });
        const design = designSchema.parse(
          (await createDesign(owner.token, { name: 'ok' }, tight)).body,
        );
        expect(
          (await putDesign(owner.token, design.id, { name: 'x', doc: many, revision: 1 }, tight))
            .body,
        ).toMatchObject({ code: 'DESIGN_DOC_TOO_LARGE', details: { reason: 'elements' } });
        const [row] = await tight.db
          .select()
          .from(shareDesigns)
          .where(eq(shareDesigns.id, design.id));
        expect(row?.revision).toBe(1);
      });

      it('gives the two document routes DESIGN_BODY_MAX_BYTES and nothing else', async () => {
        const owner = await api.photographer();
        // 50 texts of 500 Thai characters: about 90 KB of JSON, over the 64 KiB global limit but
        // under DESIGN_BODY_MAX_BYTES (96 KiB): parsed, then refused by DESIGN_DOC_MAX_BYTES.
        const big = docWith(...Array.from({ length: 50 }, (_, i) => text(`t${i}`, THAI_500)));
        const body = { name: 'Big', doc: big };
        const bytes = Buffer.byteLength(JSON.stringify(body));
        expect(bytes).toBeGreaterThan(api.config.limits.jsonBodyMaxBytes);
        expect(bytes).toBeLessThan(api.config.design.bodyMaxBytes);
        expect((await createDesign(owner.token, body)).body).toMatchObject({
          code: 'DESIGN_DOC_TOO_LARGE',
          details: { reason: 'bytes', max: 65536 },
        });
        const design = await newDesign(owner.token);
        expect(
          (await putDesign(owner.token, design.id, { ...body, revision: 1 })).body,
        ).toMatchObject({ code: 'DESIGN_DOC_TOO_LARGE' });
        // Other routes keep the small limit, design routes included.
        const asset = await api.request('POST', apiPath(D.createAsset), {
          token: owner.token,
          body: { ...body, fileName: 'a.png', mime: 'image/png', sizeBytes: 1 },
        });
        expect(asset).toMatchObject({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE' } });
        const folder = await api.folder(owner.id);
        const share = await api.request('POST', apiPath(S.create), {
          token: owner.token,
          body: { target: { type: 'folder', folderId: folder.id }, pad: big },
        });
        expect(share).toMatchObject({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE' } });
        // And the design routes stop at DESIGN_BODY_MAX_BYTES.
        const tightOwner = await tight.photographer();
        const over = {
          name: 'x',
          doc: docWith(...Array.from({ length: 12 }, (_, i) => text(`t${i}`, THAI_500))),
        };
        expect(Buffer.byteLength(JSON.stringify(over))).toBeGreaterThan(16384);
        expect(await createDesign(tightOwner.token, over, tight)).toMatchObject({
          status: 413,
          body: { code: 'PAYLOAD_TOO_LARGE' },
        });
      });

      it('reserves without a limit offline and sends design.asset once with BullMQ', async () => {
        const owner = await tight.photographer({ quotaBytes: 10 });
        const asset = await newAsset(owner, { sizeBytes: 5000 }, tight);
        expect(await tight.usage(owner.id)).toMatchObject({ reservedBytes: 5000 });
        const done = await completeAsset(owner.token, asset.assetId, tight);
        expect(done.body).toMatchObject({ status: 'processing' });
        expect(tight.queue.messages('media')).toContainEqual({
          kind: 'design.asset',
          assetId: asset.assetId,
          photographerId: owner.id,
        });
        const count = () =>
          tight.queue
            .messages('media')
            .filter((m) => (m as { assetId?: string }).assetId === asset.assetId).length;
        expect(count()).toBe(1);
        await completeAsset(owner.token, asset.assetId, tight);
        expect(count()).toBe(1);

        // An enqueue failure is logged and does not fail the request (media.sweep re-sends).
        const second = await newAsset(owner, {}, tight);
        tight.queue.failing = true;
        try {
          const res = await completeAsset(owner.token, second.assetId, tight);
          expect(res.body).toMatchObject({ status: 'processing' });
        } finally {
          tight.queue.failing = false;
        }
        expect(tight.events.of('media.enqueue_failed')).toContainEqual(
          expect.objectContaining({ designAssetId: second.assetId, photographerId: owner.id }),
        );
      });
    });
  });
}
