import { activityEvents, consents, folders, subscriptions } from '@shotx/db';
import {
  ANON_ID_COOKIE,
  apiPath,
  ME_ROUTES,
  PUBLIC_SHARE_ROUTES as P,
  SHARE_UNLOCK_COOKIE,
  shareChangesResponseSchema,
  shareItemsResponseSchema,
  shareMetaResponseSchema,
  VIEWER_SESSION_COOKIE,
} from '@shotx/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';

const meta = (token: string) => apiPath(P.meta, { token });
const items = (token: string, q = '') => `${apiPath(P.items, { token })}${q}`;
const unlock = (token: string) => apiPath(P.unlock, { token });
const consent = (token: string) => apiPath(P.giveConsent, { token });
const changes = (token: string) => apiPath(P.changes, { token });

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`share page on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, {
        env: { SHARE_PAGE_SIZE: '2', SHARE_UNLOCK_RATE_PER_IP: '3' },
      });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    async function gallery() {
      const owner = await api.photographer({ name: 'ช่างภาพ' });
      const root = await api.folder(owner.id, { name: 'Run 2026' });
      const sub = await api.folder(owner.id, { parent: root });
      const a = await api.file(owner.id, root.id, 'a.jpg');
      const b = await api.file(owner.id, sub.id, 'b.jpg');
      const c = await api.file(owner.id, sub.id, 'c.jpg');
      const share = await api.share(owner.id, { folderId: root.id });
      return { owner, root, sub, files: [a, b, c], share };
    }

    describe('gate order', () => {
      it('answers NOT_FOUND for malformed and unknown tokens alike', async () => {
        for (const token of ['nope', 'a'.repeat(22), 'AAAAAAAAAAAAAAAAAAAAA-']) {
          for (const path of [meta(token), items(token)]) {
            const res = await api.request('GET', path);
            expect(res.status, path).toBe(404);
            expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
          }
        }
      });

      it('answers SHARE_EXPIRED with a reason: revoked, expired, unavailable', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const revoked = await api.share(owner.id, { folderId: folder.id }, { isActive: false });
        const expired = await api.share(
          owner.id,
          { folderId: folder.id },
          { expiresAt: new Date(api.clock.now().getTime() - 1000) },
        );
        for (const [s, reason] of [
          [revoked, 'revoked'],
          [expired, 'expired'],
        ] as const) {
          const res = await api.request('GET', meta(s.token));
          expect(res).toMatchObject({
            status: 410,
            body: { code: 'SHARE_EXPIRED', details: { reason } },
          });
        }
        // Target trashed.
        const trashedFolder = await api.folder(owner.id);
        const s1 = await api.share(owner.id, { folderId: trashedFolder.id });
        await api.db
          .update(folders)
          .set({ deletedAt: new Date() })
          .where(eq(folders.id, trashedFolder.id));
        expect((await api.request('GET', items(s1.token))).body).toMatchObject({
          code: 'SHARE_EXPIRED',
          details: { reason: 'unavailable' },
        });
        // Subscription expired (grace still serves).
        const lapsed = await api.photographer({ status: 'grace' });
        const lf = await api.folder(lapsed.id);
        const s2 = await api.share(lapsed.id, { folderId: lf.id });
        expect((await api.request('GET', items(s2.token))).status).toBe(200);
        await api.db
          .update(subscriptions)
          .set({ status: 'expired' })
          .where(eq(subscriptions.photographerId, lapsed.id));
        expect((await api.request('GET', items(s2.token))).body).toMatchObject({
          details: { reason: 'unavailable' },
        });
      });

      it('asks for login before the password, and meta reports both as flags', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const s = await api.share(
          owner.id,
          { folderId: folder.id },
          { requireLogin: true, password: 'secret-pin' },
        );
        const anon = api.browser();
        expect((await anon.request('GET', items(s.token))).body).toMatchObject({
          code: 'LOGIN_REQUIRED',
        });
        const m = await anon.request('GET', meta(s.token));
        expect(m.status).toBe(200);
        expect(shareMetaResponseSchema.parse(m.body)).toMatchObject({
          access: { loginRequired: true, locked: true },
          details: null,
        });
        // Unlock is checked after require_login too.
        expect(
          (await anon.request('POST', unlock(s.token), { body: { password: 'secret-pin' } })).body,
        ).toMatchObject({ code: 'LOGIN_REQUIRED' });

        const viewer = await api.viewer();
        const signedIn = api.browser();
        signedIn.token = viewer.token;
        expect((await signedIn.request('GET', items(s.token))).body).toMatchObject({
          code: 'PASSWORD_REQUIRED',
        });
        const wrong = await signedIn.request('POST', unlock(s.token), {
          body: { password: 'nope' },
        });
        expect(wrong).toMatchObject({ status: 403, body: { code: 'PASSWORD_INCORRECT' } });
        const ok = await signedIn.request('POST', unlock(s.token), {
          body: { password: 'secret-pin' },
        });
        expect(ok.status).toBe(204);
        expect(signedIn.cookie(SHARE_UNLOCK_COOKIE, `/api/s/${s.token}`)).toMatch(
          /^[0-9A-Za-z]{22}$/,
        );
        expect((await signedIn.request('GET', items(s.token))).status).toBe(200);
        // The unlock proof lives in Redis with a TTL, keyed by the cookie's hash.
        const key = api.store.keys().find((k) => k.startsWith(`share-unlock:${s.id}:`));
        expect(key).toBeDefined();
        expect(api.store.ttlSeconds(key ?? '')).toBe(api.config.share.unlockTtlSeconds);
      });

      it('locks everyone out again when the password changes', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const s = await api.share(owner.id, { folderId: folder.id }, { password: 'first' });
        const b = api.browser();
        await b.request('POST', unlock(s.token), { body: { password: 'first' } });
        expect((await b.request('GET', items(s.token))).status).toBe(200);
        const res = await api.request('PATCH', `/api/shares/${s.id}`, {
          token: owner.token,
          body: { password: 'second' },
        });
        expect(res.status).toBe(200);
        expect((await b.request('GET', items(s.token))).body).toMatchObject({
          code: 'PASSWORD_REQUIRED',
        });
      });

      it('rate-limits unlock attempts per IP and share', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const s = await api.share(owner.id, { folderId: folder.id }, { password: 'pin1' });
        const b = api.browser();
        for (let i = 0; i < 3; i++) {
          expect(
            (await b.request('POST', unlock(s.token), { body: { password: 'x' } })).status,
          ).toBe(403);
        }
        const limited = await b.request('POST', unlock(s.token), { body: { password: 'pin1' } });
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
      });

      it('unlock on a share without a password is a no-op', async () => {
        const { share } = await gallery();
        const b = api.browser();
        expect(
          (await b.request('POST', unlock(share.token), { body: { password: 'x' } })).status,
        ).toBe(204);
        expect(b.cookie(SHARE_UNLOCK_COOKIE)).toBeUndefined();
      });
    });

    describe('viewer identity', () => {
      it('sets the anon cookie once and keeps it', async () => {
        const { share } = await gallery();
        const b = api.browser();
        const first = await b.request('GET', meta(share.token));
        const anon = b.cookie(ANON_ID_COOKIE, '/');
        expect(anon).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.headers.getSetCookie()[0]).toContain('HttpOnly');
        expect(first.headers.getSetCookie()[0]).toContain('SameSite=Lax');
        const again = await b.request('GET', meta(share.token));
        expect(again.headers.getSetCookie()).toEqual([]);
        expect(b.cookie(ANON_ID_COOKIE)).toBe(anon);
      });

      it('replaces a malformed anon cookie instead of failing', async () => {
        const { share } = await gallery();
        const b = api.browser();
        b.setCookie(ANON_ID_COOKIE, 'not-a-uuid');
        expect((await b.request('GET', meta(share.token))).status).toBe(200);
        expect(b.cookie(ANON_ID_COOKIE)).toMatch(/^[0-9a-f]{8}-/);
      });

      it('treats an invalid bearer token or viewer session as UNAUTHENTICATED', async () => {
        const { share } = await gallery();
        const bad = await api.request('GET', meta(share.token), {
          headers: { authorization: 'Bearer x.y.z' },
        });
        expect(bad.status).toBe(401);
        const admin = await api.auth.token('admins', 'admin-1');
        expect((await api.request('GET', meta(share.token), { token: admin })).status).toBe(401);
        const b = api.browser();
        b.setCookie(VIEWER_SESSION_COOKIE, 'A'.repeat(22), '/api');
        expect((await b.request('GET', meta(share.token))).status).toBe(401);
      });

      it('carries a signed-in viewer through the viewer-session cookie', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id);
        const s = await api.share(owner.id, { folderId: folder.id }, { requireLogin: true });
        const viewer = await api.viewer();
        const b = api.browser();
        // The BFF creates the session with the user's token and forwards Set-Cookie.
        const created = await b.request('POST', apiPath(ME_ROUTES.createViewerSession), {
          token: viewer.token,
        });
        expect(created.status).toBe(204);
        expect(b.cookie(VIEWER_SESSION_COOKIE, '/api')).toMatch(/^[0-9A-Za-z]{22}$/);
        expect((await b.request('GET', items(s.token))).status).toBe(200);
        const out = await b.request('DELETE', apiPath(ME_ROUTES.deleteViewerSession));
        expect(out.status).toBe(204);
        expect(b.cookie(VIEWER_SESSION_COOKIE)).toBeUndefined();
        expect((await b.request('GET', items(s.token))).body).toMatchObject({
          code: 'LOGIN_REQUIRED',
        });
        // Signing out with an expired session still clears the cookie.
        b.setCookie(VIEWER_SESSION_COOKIE, 'B'.repeat(22), '/api');
        expect((await b.request('DELETE', apiPath(ME_ROUTES.deleteViewerSession))).status).toBe(
          204,
        );
        expect(b.cookie(VIEWER_SESSION_COOKIE)).toBeUndefined();
      });

      it('refuses state-changing requests from another origin', async () => {
        const { share } = await gallery();
        const res = await api.request('POST', unlock(share.token), {
          body: { password: 'x' },
          headers: { origin: 'https://evil.example' },
        });
        expect(res).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
        const same = await api.request('POST', unlock(share.token), {
          body: { password: 'x' },
          headers: { origin: 'http://localhost:3000' },
        });
        expect(same.status).toBe(204);
        // GETs are not checked.
        const get = await api.request('GET', meta(share.token), {
          headers: { origin: 'https://evil.example' },
        });
        expect(get.status).toBe(200);
        for (const path of [consent(share.token), apiPath(P.downloads, { token: share.token })]) {
          expect(
            (await api.request('POST', path, { body: {}, headers: { origin: 'null' } })).status,
          ).toBe(403);
        }
        expect(
          (
            await api.request('DELETE', consent(share.token), {
              headers: { origin: 'https://x.example' },
            })
          ).status,
        ).toBe(403);
      });
    });

    describe('meta and items', () => {
      it('describes a gallery share with a cover and an item count', async () => {
        const { share } = await gallery();
        const res = await api.request('GET', meta(share.token));
        const body = shareMetaResponseSchema.parse(res.body);
        expect(body).toMatchObject({
          targetType: 'folder',
          mode: 'gallery',
          access: { loginRequired: false, locked: false },
          details: { title: 'Run 2026', photographerName: 'ช่างภาพ', itemCount: 3 },
          faceSearch: { available: false, policyVersion: null, consented: false },
        });
        expect(body.details?.cover?.previewUrl).toMatch(
          /^https:\/\/photos\.example\.com\/media\/derived\//,
        );
      });

      it('ADR 0020: changes moves when photos arrive, is cached briefly and logs nothing', async () => {
        const { owner, root, share } = await gallery();
        const b = api.browser();
        const read = async () => {
          const res = await b.request('GET', changes(share.token));
          expect(res.status).toBe(200);
          return shareChangesResponseSchema.parse(res.body).version;
        };
        const eventsBefore = (
          await api.db.select().from(activityEvents).where(eq(activityEvents.shareId, share.id))
        ).length;
        const v1 = await read();
        expect(await read()).toBe(v1);
        // A new photo: the cached answer holds for SHARE_CHANGES_CACHE_SECONDS, then moves.
        await api.file(owner.id, root.id, 'd.jpg');
        expect(await read()).toBe(v1);
        api.clock.advance(5_000);
        const v2 = await read();
        expect(v2).not.toBe(v1);
        api.clock.advance(5_000);
        expect(await read()).toBe(v2);
        // Polling writes no activity event.
        const eventsAfter = (
          await api.db.select().from(activityEvents).where(eq(activityEvents.shareId, share.id))
        ).length;
        expect(eventsAfter).toBe(eventsBefore);
        // Same gates as items: a revoked share answers SHARE_EXPIRED.
        const revoked = await api.share(owner.id, { folderId: root.id }, { isActive: false });
        expect((await b.request('GET', changes(revoked.token))).body).toMatchObject({
          code: 'SHARE_EXPIRED',
        });
      });

      it('pages items newest first by (taken_at, created_at, id) with signed, cacheable URLs', async () => {
        const { share, files } = await gallery();
        const b = api.browser();
        const page1 = shareItemsResponseSchema.parse(
          (await b.request('GET', items(share.token))).body,
        );
        expect(page1.items).toHaveLength(2);
        expect(page1.nextCursor).not.toBeNull();
        const page2 = shareItemsResponseSchema.parse(
          (await b.request('GET', items(share.token, `?cursor=${page1.nextCursor ?? ''}`))).body,
        );
        // Owner, 2026-11-13: the latest photos first.
        expect([...page1.items, ...page2.items].map((i) => i.id)).toEqual(
          files.map((f) => f.id).reverse(),
        );
        expect(page2.nextCursor).toBeNull();
        // Byte-identical URLs within the bucket window.
        const again = shareItemsResponseSchema.parse(
          (await b.request('GET', items(share.token))).body,
        );
        expect(again.items[0]?.thumbUrl).toBe(page1.items[0]?.thumbUrl);
        const item = page1.items[0];
        expect(item?.thumbUrl).toContain('Signature=');
        expect(JSON.stringify(page1)).not.toContain('amazonaws.com');
      });

      it('rejects cursors of another share', async () => {
        const one = await gallery();
        const two = await gallery();
        const page = shareItemsResponseSchema.parse(
          (await api.request('GET', items(one.share.token))).body,
        );
        const res = await api.request(
          'GET',
          items(two.share.token, `?cursor=${page.nextCursor ?? ''}`),
        );
        expect(res).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
      });

      it('serves only ready, live files under the root, following moves', async () => {
        const owner = await api.photographer();
        const root = await api.folder(owner.id);
        const outside = await api.folder(owner.id);
        const inside = await api.file(owner.id, root.id);
        const elsewhere = await api.file(owner.id, outside.id);
        const trashed = await api.file(owner.id, root.id);
        await api.trashFile(trashed.id);
        const other = await api.photographer();
        await api.file(other.id, null);
        const s = await api.share(owner.id, { folderId: root.id });
        const ids = async () =>
          shareItemsResponseSchema
            .parse((await api.request('GET', items(s.token, '?limit=50'))).body)
            .items.map((i) => i.id);
        expect(await ids()).toEqual([inside.id]);
        // Move `outside` under the root: its file joins the share.
        await api.request('PATCH', `/api/drive/folders/${outside.id}`, {
          token: owner.token,
          body: { parentId: root.id },
        });
        expect((await ids()).sort()).toEqual([inside.id, elsewhere.id].sort());
      });

      it('serves a file share as that one file', async () => {
        const owner = await api.photographer();
        const f = await api.file(owner.id, null);
        await api.file(owner.id, null);
        const s = await api.share(owner.id, { fileId: f.id });
        const body = shareItemsResponseSchema.parse(
          (await api.request('GET', items(s.token))).body,
        );
        expect(body.items.map((i) => i.id)).toEqual([f.id]);
      });

      it('writes one view event per items page, with counts only', async () => {
        const { share, owner } = await gallery();
        const b = api.browser();
        await b.request('GET', items(share.token));
        const events = await api.db
          .select()
          .from(activityEvents)
          .where(and(eq(activityEvents.shareId, share.id), eq(activityEvents.type, 'view')));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          source: 'share',
          photographerId: owner.id,
          fileId: null,
          bytes: 0,
          meta: { items: 2 },
          viewerId: null,
          anonId: b.cookie(ANON_ID_COOKIE),
        });
      });
    });

    describe('consent', () => {
      it('is FEATURE_DISABLED while face search is off, but withdrawal always works', async () => {
        const { share } = await gallery();
        const res = await api.request('POST', consent(share.token), {
          body: { policyVersion: '2026-10-25', accepted: true },
        });
        expect(res).toMatchObject({
          status: 404,
          body: { code: 'FEATURE_DISABLED', details: { feature: 'face_search' } },
        });
        expect((await api.request('DELETE', consent(share.token))).status).toBe(204);
        // Even on a revoked share.
        const owner = await api.photographer();
        const f = await api.folder(owner.id);
        const revoked = await api.share(owner.id, { folderId: f.id }, { isActive: false });
        expect((await api.request('DELETE', consent(revoked.token))).status).toBe(204);
        expect((await api.request('DELETE', consent('x'))).status).toBe(404);
      });

      it('leaves consents untouched for other viewers on withdrawal', async () => {
        const { share } = await gallery();
        await api.db.insert(consents).values({
          shareId: share.id,
          anonId: '3b241101-e2bb-4255-8caf-4136c566a962',
          policyVersion: '2026-10-25',
          ipHash: 'v1:x',
        });
        await api.browser().request('DELETE', consent(share.token));
        const [row] = await api.db.select().from(consents).where(eq(consents.shareId, share.id));
        expect(row?.withdrawnAt).toBeNull();
      });
    });
  });
}
