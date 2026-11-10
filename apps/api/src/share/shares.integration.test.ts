import { shareDailyStats, shares, subscriptions, users } from '@shotx/db';
import {
  apiPath,
  listSharesResponseSchema,
  ME_ROUTES,
  meResponseSchema,
  ownerShareSchema,
  SHARE_ROUTES as R,
  shareStatsResponseSchema,
} from '@shotx/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../auth/password';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';
import { addDays, bangkokDate } from './shares.service';

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`shares and /me on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, { env: { SHARE_PAGE_SIZE: '2' } });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    const create = (token: string, body: unknown) =>
      api.request('POST', apiPath(R.create), { token, body });

    describe('POST /shares', () => {
      it('creates a folder share with a CSPRNG token and an argon2id password', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id, { name: 'Event' });
        const res = await create(owner.token, {
          target: { type: 'folder', folderId: folder.id },
          password: 'pin-1234',
          expiresAt: '2027-01-01T00:00:00.000Z',
        });
        expect(res.status).toBe(201);
        const share = ownerShareSchema.parse(res.body);
        expect(share).toMatchObject({
          url: `http://localhost:3000/s/${share.token}`,
          target: { type: 'folder', id: folder.id, name: 'Event', unavailable: false },
          mode: 'gallery',
          allowDownload: true,
          downloadSize: 'web',
          passwordProtected: true,
          status: 'active',
        });
        expect(share.token).toMatch(/^[0-9A-Za-z]{22}$/);
        expect(JSON.stringify(res.body)).not.toContain('pin-1234');
        const [row] = await api.db.select().from(shares).where(eq(shares.id, share.id));
        expect(row?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
        expect(await verifyPassword('pin-1234', row?.passwordHash ?? '')).toBe(true);
        expect(await verifyPassword('pin-1235', row?.passwordHash ?? '')).toBe(false);
      });

      it('shares only ready, live items of the caller', async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const theirs = await api.file(other.id, null);
        const trashed = await api.file(owner.id, null);
        await api.trashFile(trashed.id);
        for (const fileId of [theirs.id, trashed.id]) {
          const res = await create(owner.token, { target: { type: 'file', fileId } });
          expect(res.status, fileId).toBe(404);
        }
        const theirFolder = await api.folder(other.id);
        expect(
          (await create(owner.token, { target: { type: 'folder', folderId: theirFolder.id } }))
            .status,
        ).toBe(404);
      });

      it('rejects face_only on files, past expiries, inactive subscriptions and the flag off', async () => {
        const owner = await api.photographer();
        const f = await api.file(owner.id, null);
        const folder = await api.folder(owner.id);
        expect(
          (await create(owner.token, { target: { type: 'file', fileId: f.id }, mode: 'face_only' }))
            .status,
        ).toBe(400);
        expect(
          (
            await create(owner.token, {
              target: { type: 'folder', folderId: folder.id },
              expiresAt: '2020-01-01T00:00:00.000Z',
            })
          ).body,
        ).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { issues: [{ path: ['body', 'expiresAt'] }] },
        });
        expect(
          (
            await create(owner.token, {
              target: { type: 'folder', folderId: folder.id },
              mode: 'face_only',
            })
          ).body,
        ).toMatchObject({ code: 'FEATURE_DISABLED' });
        const lapsed = await api.photographer({ status: 'expired' });
        const lf = await api.folder(lapsed.id);
        expect(
          (await create(lapsed.token, { target: { type: 'folder', folderId: lf.id } })).body,
        ).toMatchObject({
          code: 'SUBSCRIPTION_INACTIVE',
          details: { status: 'expired' },
        });
        // Grace may still share.
        const grace = await api.photographer({ status: 'grace' });
        const gf = await api.folder(grace.id);
        expect(
          (await create(grace.token, { target: { type: 'folder', folderId: gf.id } })).status,
        ).toBe(201);
      });

      it('is FORBIDDEN for viewers', async () => {
        const viewer = await api.viewer();
        const res = await create(viewer.token, { target: { type: 'folder', folderId: viewer.id } });
        expect(res).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
      });
    });

    describe('list, get, update, revoke', () => {
      it('lists newest first with cursors, filtered by target, never other owners', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const f = await api.file(owner.id, null);
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          ids.push(
            ownerShareSchema.parse(
              (await create(owner.token, { target: { type: 'folder', folderId: folder.id } })).body,
            ).id,
          );
        }
        const fileShare = ownerShareSchema.parse(
          (await create(owner.token, { target: { type: 'file', fileId: f.id } })).body,
        );
        const other = await api.photographer();
        await create(other.token, {
          target: { type: 'folder', folderId: (await api.folder(other.id)).id },
        });

        const page1 = listSharesResponseSchema.parse(
          (await api.request('GET', apiPath(R.list), { token: owner.token })).body,
        );
        expect(page1.items.map((s) => s.id)).toEqual([fileShare.id, ids[2]]);
        const page2 = listSharesResponseSchema.parse(
          (
            await api.request(
              'GET',
              `${apiPath(R.list)}?cursor=${page1.nextCursor ?? ''}&limit=10`,
              { token: owner.token },
            )
          ).body,
        );
        expect(page2.items.map((s) => s.id)).toEqual([ids[1], ids[0]]);
        expect(page2.nextCursor).toBeNull();
        const byFile = listSharesResponseSchema.parse(
          (await api.request('GET', `${apiPath(R.list)}?fileId=${f.id}`, { token: owner.token }))
            .body,
        );
        expect(byFile.items.map((s) => s.id)).toEqual([fileShare.id]);
        expect(
          (await api.request('GET', `${apiPath(R.list)}?cursor=garbage`, { token: owner.token }))
            .status,
        ).toBe(400);
      });

      it('updates settings, removes passwords, and keeps revocation final', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const s = ownerShareSchema.parse(
          (
            await create(owner.token, {
              target: { type: 'folder', folderId: folder.id },
              password: 'abcd',
            })
          ).body,
        );
        const path = apiPath(R.update, { id: s.id });
        const patched = await api.request('PATCH', path, {
          token: owner.token,
          body: {
            allowDownload: false,
            downloadSize: 'original',
            password: null,
            requireLogin: true,
          },
        });
        expect(patched.body).toMatchObject({
          allowDownload: false,
          downloadSize: 'original',
          passwordProtected: false,
          requireLogin: true,
        });
        expect((await api.request('PATCH', path, { token: owner.token, body: {} })).status).toBe(
          400,
        );
        expect(
          (await api.request('PATCH', path, { token: owner.token, body: { mode: 'face_only' } }))
            .body,
        ).toMatchObject({
          code: 'FEATURE_DISABLED',
        });
        const other = await api.photographer();
        expect(
          (await api.request('PATCH', path, { token: other.token, body: { allowDownload: true } }))
            .status,
        ).toBe(404);
        expect(
          (await api.request('GET', apiPath(R.get, { id: s.id }), { token: other.token })).status,
        ).toBe(404);
        expect(
          (await api.request('DELETE', apiPath(R.revoke, { id: s.id }), { token: other.token }))
            .status,
        ).toBe(404);

        expect(
          (await api.request('DELETE', apiPath(R.revoke, { id: s.id }), { token: owner.token }))
            .status,
        ).toBe(204);
        expect(
          (await api.request('DELETE', apiPath(R.revoke, { id: s.id }), { token: owner.token }))
            .status,
        ).toBe(204);
        expect(
          (await api.request('GET', apiPath(R.get, { id: s.id }), { token: owner.token })).body,
        ).toMatchObject({
          status: 'revoked',
        });
        expect(
          (await api.request('PATCH', path, { token: owner.token, body: { allowDownload: true } }))
            .body,
        ).toMatchObject({
          code: 'CONFLICT',
        });
      });

      it('reports trashed targets as unavailable and passed expiries as expired', async () => {
        const owner = await api.photographer();
        const f = await api.file(owner.id, null);
        const s = ownerShareSchema.parse(
          (
            await create(owner.token, {
              target: { type: 'file', fileId: f.id },
              expiresAt: new Date(api.clock.now().getTime() + 60_000).toISOString(),
            })
          ).body,
        );
        await api.trashFile(f.id);
        api.clock.advance(120_000);
        const got = ownerShareSchema.parse(
          (await api.request('GET', apiPath(R.get, { id: s.id }), { token: owner.token })).body,
        );
        expect(got).toMatchObject({ status: 'expired', target: { unavailable: true } });
        api.clock.advance(-120_000);
      });
    });

    describe('GET /shares/:id/stats', () => {
      it('sums the rollup days in range and defaults to the last 30 Bangkok days', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const s = await api.share(owner.id, { folderId: folder.id });
        const today = bangkokDate(api.clock.now());
        const day = (date: string, visitors: number) => ({
          shareId: s.id,
          photographerId: owner.id,
          date,
          visitors,
          scanners: 1,
          scans: 2,
          downloads: 3,
          uniqueDownloaders: 1,
          zips: 1,
          bytesOut: 1000,
        });
        await api.db
          .insert(shareDailyStats)
          .values([day(addDays(today, -40), 9), day(addDays(today, -2), 5), day(today, 7)]);
        const res = await api.request('GET', apiPath(R.stats, { id: s.id }), {
          token: owner.token,
        });
        const body = shareStatsResponseSchema.parse(res.body);
        expect(body).toMatchObject({ from: addDays(today, -29), to: today });
        expect(body.days.map((d) => d.date)).toEqual([addDays(today, -2), today]);
        expect(body.totals).toEqual({
          visitors: 12,
          scanners: 2,
          scans: 4,
          downloads: 6,
          uniqueDownloaders: 2,
          zips: 2,
          bytesOut: 2000,
        });
        expect(body.rolledUpAt).not.toBeNull();
        const long = await api.request(
          'GET',
          `${apiPath(R.stats, { id: s.id })}?from=2025-01-01&to=2026-06-01`,
          { token: owner.token },
        );
        expect(long.status).toBe(400);
        const other = await api.photographer();
        expect(
          (await api.request('GET', apiPath(R.stats, { id: s.id }), { token: other.token })).status,
        ).toBe(404);
      });
    });

    describe('/me', () => {
      it('provisions a viewer on the first token, from verified ID-token claims only', async () => {
        const token = await api.auth.token('users', 'first-time-sub', {
          tokenUse: 'id',
          extra: { email: 'new@example.com', email_verified: true, name: ' Somchai ' },
        });
        const res = await api.request('GET', apiPath(ME_ROUTES.get), { token });
        expect(res.status).toBe(200);
        expect(meResponseSchema.parse(res.body)).toMatchObject({
          role: 'user',
          email: 'new@example.com',
          name: 'Somchai',
          subscription: null,
          features: { faceSearch: false },
        });
        // Idempotent, never changes the row.
        const again = await api.request('GET', apiPath(ME_ROUTES.get), {
          token: await api.auth.token('users', 'first-time-sub'),
        });
        expect((again.body as { id: string }).id).toBe((res.body as { id: string }).id);
        const unverified = await api.auth.token('users', 'unverified-sub', {
          tokenUse: 'id',
          extra: { email: 'x@example.com', email_verified: false },
        });
        expect(
          (await api.request('GET', apiPath(ME_ROUTES.get), { token: unverified })).body,
        ).toMatchObject({
          email: null,
        });
        const rows = await api.db
          .select()
          .from(users)
          .where(eq(users.authSubject, 'first-time-sub'));
        expect(rows).toHaveLength(1);
      });

      it('rejects admins-pool tokens and anonymous calls', async () => {
        expect((await api.request('GET', apiPath(ME_ROUTES.get))).status).toBe(401);
        const admin = await api.auth.token('admins', 'admin-sub');
        expect((await api.request('GET', apiPath(ME_ROUTES.get), { token: admin })).status).toBe(
          401,
        );
      });

      it('never makes a photographer: POST /me/photographer is FORBIDDEN (ADR 0010)', async () => {
        const token = await api.auth.token('users', 'becoming-photographer');
        // A viewer can't use photographer routes (and gets provisioned on the way).
        expect((await api.request('GET', '/api/drive/usage', { token })).body).toMatchObject({
          code: 'FORBIDDEN',
        });
        for (const body of [{ name: 'Studio A' }, {}, { unknown: true }]) {
          const res = await api.request('POST', apiPath(ME_ROUTES.becomePhotographer), {
            token,
            body,
          });
          expect(res.status).toBe(403);
          expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
        }
        const [viewer] = await api.db
          .select()
          .from(users)
          .where(eq(users.authSubject, 'becoming-photographer'));
        expect(viewer?.role).toBe('user');
        expect(
          await api.db
            .select()
            .from(subscriptions)
            .where(and(eq(subscriptions.photographerId, viewer?.id ?? ''))),
        ).toHaveLength(0);
        expect((await api.request('GET', '/api/drive/usage', { token })).status).toBe(403);
        // GET /me says the session is not restricted.
        const me = meResponseSchema.parse(
          (await api.request('GET', apiPath(ME_ROUTES.get), { token })).body,
        );
        expect(me).toMatchObject({ role: 'user', passwordChangeRequired: false });
      });
    });
  });
}
