import { packages, photographerPackages, storageUsage } from '@shotx/db';
import {
  apiPath,
  DRIVE_ROUTES as D,
  driveUsageResponseSchema,
  type OwnerShare,
  PACKAGE_ROUTES,
  PUBLIC_SHARE_ROUTES as P,
  SHARE_ROUTES as S,
  UPLOAD_ROUTES as U,
  type UploadInitResponse,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { OFFLINE_ACCOUNTS_ENV } from '../testing/fakes';
import { TestApi } from '../testing/harness';

// ADR 0026 §2 enforcement: the photo count on upload init and abort, expiry on uploads, shares
// (create, un-pause, re-open), face indexing, share serving and GET /drive/usage; accounts without
// a package row (admin-created) stay unlimited everywhere.

const MiB = 1024 * 1024;
const DAY = 24 * 3600 * 1000;

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`ADR 0026 package limits on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, {
        env: { ...OFFLINE_ACCOUNTS_ENV, FACE_SEARCH_ENABLED: 'true' },
        limits: { uploadInitRate: { limit: 1000, windowSeconds: 60 } },
      });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    type Me = Awaited<ReturnType<TestApi['photographer']>>;

    /** Gives `me` a package row (as Free sign-up or a paid order would). */
    async function withPackage(
      me: Me,
      opts: { photoLimit?: number; photosUsed?: number; expiresInMs?: number } = {},
    ) {
      const [free] = await api.db.select().from(packages).where(eq(packages.code, 'free'));
      if (free === undefined) throw new Error('free package not seeded');
      const now = api.clock.now().getTime();
      const expiresAt = new Date(now + (opts.expiresInMs ?? 3 * DAY));
      await api.db.insert(photographerPackages).values({
        photographerId: me.id,
        packageId: free.id,
        startsAt: new Date(Math.min(now, expiresAt.getTime()) - DAY),
        expiresAt,
        photoLimit: opts.photoLimit ?? 100,
        photosUsed: opts.photosUsed ?? 0,
      });
    }
    const photosUsed = async (me: Me) =>
      (
        await api.db
          .select()
          .from(photographerPackages)
          .where(eq(photographerPackages.photographerId, me.id))
      )[0]?.photosUsed;

    const init = (me: Me, name = `IMG_${Math.random().toString(36).slice(2, 8)}.JPG`) =>
      api.request<UploadInitResponse>('POST', apiPath(U.init), {
        token: me.token,
        body: { name, size: 2 * MiB, mime: 'image/jpeg', folderId: null },
      });
    const abort = (me: Me, id: string) =>
      api.request('DELETE', apiPath(U.abort, { id }), { token: me.token });
    const usage = async (me: Me) =>
      driveUsageResponseSchema.parse(
        (await api.request('GET', apiPath(D.usage), { token: me.token })).body,
      );

    describe('uploads', () => {
      it('counts one photo per init, refuses the next one at the limit, and abort gives it back', async () => {
        const me = await api.photographer();
        await withPackage(me, { photoLimit: 2 });
        const first = await init(me);
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        expect((await init(me)).status).toBe(201);
        expect(await photosUsed(me)).toBe(2);
        expect((await usage(me)).uploadsBlockedBy).toBe('PHOTO_LIMIT_REACHED');

        const refused = await init(me);
        expect(refused).toMatchObject({
          status: 403,
          body: {
            code: 'PHOTO_LIMIT_REACHED',
            details: { photoLimit: 2, photosUsed: 2, requested: 1 },
          },
        });
        // Nothing was reserved for the refused file.
        const reservedBefore = (await api.usage(me.id)).reservedBytes;
        expect(reservedBefore).toBe(4 * MiB);

        expect((await abort(me, first.body.fileId)).status).toBe(204);
        expect(await photosUsed(me)).toBe(1);
        expect((await usage(me)).uploadsBlockedBy).toBeNull();
        expect((await init(me)).status).toBe(201);
        expect(await photosUsed(me)).toBe(2);
      });

      it('lets only one of two concurrent inits take the last photo', async () => {
        const me = await api.photographer();
        await withPackage(me, { photoLimit: 1 });
        const results = await Promise.all([init(me), init(me)]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
        expect(await photosUsed(me)).toBe(1);
      });

      it('runs inits and aborts of one account concurrently without a deadlock', async () => {
        const me = await api.photographer();
        await withPackage(me, { photoLimit: 1000 });
        const opened = await Promise.all(Array.from({ length: 4 }, () => init(me)));
        const ids = opened.map((r) => r.body.fileId);
        const results = await Promise.all([
          ...ids.map((id) => abort(me, id)),
          ...Array.from({ length: 4 }, () => init(me)),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([
          201, 201, 201, 201, 204, 204, 204, 204,
        ]);
        expect(await photosUsed(me)).toBe(4);
        expect((await api.usage(me.id)).reservedBytes).toBe(4 * 2 * MiB);
      });

      it('refuses uploads once the package has expired', async () => {
        const me = await api.photographer();
        await withPackage(me, { expiresInMs: 60_000 });
        expect((await init(me)).status).toBe(201);
        api.clock.advance(60_000);
        try {
          const res = await init(me);
          expect(res).toMatchObject({ status: 403, body: { code: 'PLAN_EXPIRED' } });
          const expiresAt = (res.body as unknown as { details: { expiresAt: string } }).details
            .expiresAt;
          expect(Date.parse(expiresAt)).toBe(api.clock.now().getTime());
          expect(await photosUsed(me)).toBe(1);
          expect((await usage(me)).uploadsBlockedBy).toBe('PLAN_EXPIRED');
        } finally {
          api.clock.advance(-60_000);
        }
      });

      it('leaves unlimited (no package row) accounts alone', async () => {
        const me = await api.photographer();
        for (let i = 0; i < 3; i++) expect((await init(me)).status).toBe(201);
        expect(await photosUsed(me)).toBeUndefined();
        expect((await usage(me)).uploadsBlockedBy).toBeNull();
        const mine = await api.request('GET', apiPath(PACKAGE_ROUTES.myPackage), {
          token: me.token,
        });
        expect(mine.status).toBe(200);
        expect(mine.body).toBeNull();
        expect(mine.headers.get('content-type')).toContain('application/json');
        const [counters] = await api.db
          .select()
          .from(storageUsage)
          .where(eq(storageUsage.photographerId, me.id));
        expect(counters?.reservedBytes).toBe(6 * MiB);
      });
    });

    describe('shares and face indexing', () => {
      it('refuses new shares, un-pausing, re-opening and face indexing after expiry', async () => {
        const me = await api.photographer();
        await withPackage(me, { expiresInMs: 60_000 });
        const folder = await api.folder(me.id);
        const create = () =>
          api.request<OwnerShare>('POST', apiPath(S.create), {
            token: me.token,
            body: { target: { type: 'folder', folderId: folder.id } },
          });
        const created = await create();
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const update = (body: unknown) =>
          api.request('PATCH', apiPath(S.update, { id: created.body.id }), {
            token: me.token,
            body,
          });
        expect((await update({ paused: true })).status).toBe(200);

        api.clock.advance(60_000);
        try {
          expect(await create()).toMatchObject({ status: 403, body: { code: 'PLAN_EXPIRED' } });
          expect(await update({ paused: false })).toMatchObject({
            status: 403,
            body: { code: 'PLAN_EXPIRED' },
          });
          // Other edits still work, pausing too.
          expect((await update({ allowDownload: false })).status).toBe(200);
          expect((await update({ paused: true })).status).toBe(200);
          const faceIndex = await api.request(
            'PATCH',
            apiPath(D.updateFaceIndex, { id: folder.id }),
            { token: me.token, body: { enabled: true } },
          );
          expect(faceIndex).toMatchObject({ status: 403, body: { code: 'PLAN_EXPIRED' } });
          const off = await api.request('PATCH', apiPath(D.updateFaceIndex, { id: folder.id }), {
            token: me.token,
            body: { enabled: false },
          });
          expect(off.status).toBe(200);
        } finally {
          api.clock.advance(-60_000);
        }
      });

      it('refuses giving an expired share a new expiry after the package expired', async () => {
        const me = await api.photographer();
        await withPackage(me, { expiresInMs: 10 * 60_000 });
        const folder = await api.folder(me.id);
        const expiresAt = new Date(api.clock.now().getTime() + 60_000).toISOString();
        const created = await api.request<OwnerShare>('POST', apiPath(S.create), {
          token: me.token,
          body: { target: { type: 'folder', folderId: folder.id }, expiresAt },
        });
        expect(created.status).toBe(201);
        api.clock.advance(10 * 60_000);
        try {
          const res = await api.request('PATCH', apiPath(S.update, { id: created.body.id }), {
            token: me.token,
            body: { expiresAt: null },
          });
          expect(res).toMatchObject({ status: 403, body: { code: 'PLAN_EXPIRED' } });
        } finally {
          api.clock.advance(-10 * 60_000);
        }
      });
    });

    describe('share serving', () => {
      it('stops serving every share of the owner once the package has expired', async () => {
        const me = await api.photographer();
        await withPackage(me, { expiresInMs: 60_000 });
        const folder = await api.folder(me.id);
        await api.file(me.id, folder.id);
        const share = await api.share(me.id, { folderId: folder.id });
        const meta = apiPath(P.meta, { token: share.token });
        const items = apiPath(P.items, { token: share.token });
        expect((await api.request('GET', meta)).status).toBe(200);
        expect((await api.request('GET', items)).status).toBe(200);

        api.clock.advance(60_000);
        try {
          for (const path of [meta, items]) {
            expect(await api.request('GET', path)).toMatchObject({
              status: 410,
              body: { code: 'SHARE_EXPIRED', details: { reason: 'plan_expired' } },
            });
          }
          // A revoked share still says revoked first.
          const revoked = await api.share(me.id, { folderId: folder.id }, { isActive: false });
          expect(await api.request('GET', apiPath(P.meta, { token: revoked.token }))).toMatchObject(
            { body: { details: { reason: 'revoked' } } },
          );

          // Renewing (a later expiry) reopens the same link.
          await api.db
            .update(photographerPackages)
            .set({ expiresAt: new Date(api.clock.now().getTime() + DAY) })
            .where(eq(photographerPackages.photographerId, me.id));
          expect((await api.request('GET', meta)).status).toBe(200);
        } finally {
          api.clock.advance(-60_000);
        }
      });

      it('serves the shares of unlimited accounts as before', async () => {
        const me = await api.photographer();
        const folder = await api.folder(me.id);
        await api.file(me.id, folder.id);
        const share = await api.share(me.id, { folderId: folder.id });
        api.clock.advance(365 * DAY);
        try {
          expect((await api.request('GET', apiPath(P.meta, { token: share.token }))).status).toBe(
            200,
          );
        } finally {
          api.clock.advance(-365 * DAY);
        }
      });
    });
  });
}
