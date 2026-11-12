import { consents, files, folders, shares } from '@shotx/db';
import {
  apiPath,
  DRIVE_ROUTES as D,
  driveFolderSchema,
  ownerShareSchema,
  PUBLIC_SHARE_ROUTES as P,
  SHARE_ROUTES as S,
  shareMetaResponseSchema,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';

// ADR 0011: readable share refs (slug or token), their enumeration limits, the folder cover and
// the consent locale. Photographers come from the harness (Cognito-like test tokens).

const publicPath = (ref: string) => `/api/s/${encodeURIComponent(ref)}`;

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`event gallery (ADR 0011) on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    /** Tight enumeration limits, on its own app (all test requests share one client IP). */
    let guarded: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db);
      guarded = await TestApi.start(database.db, {
        env: {
          SHARE_NOT_FOUND_RATE_PER_IP: '3',
          SHARE_SLUG_RESOLVE_RATE_PER_IP: '8',
        },
      });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await guarded?.close();
      await database?.close();
    });

    async function folderShare(app: TestApi, name: string, body: Record<string, unknown> = {}) {
      const owner = await app.photographer();
      const folder = await app.folder(owner.id, { name });
      const file = await app.file(owner.id, folder.id);
      const res = await app.request('POST', apiPath(S.create), {
        token: owner.token,
        body: { target: { type: 'folder', folderId: folder.id }, ...body },
      });
      expect(res.status).toBe(201);
      return { owner, folder, file, share: ownerShareSchema.parse(res.body) };
    }

    describe('slugs on create', () => {
      it('makes the slug from the folder name, with a suffix only when taken', async () => {
        const first = await folderShare(api, 'Bangkok Marathon 2026!');
        expect(first.share).toMatchObject({
          slug: 'bangkok-marathon-2026',
          path: '/s/bangkok-marathon-2026',
          url: 'http://localhost:3000/s/bangkok-marathon-2026',
        });
        // Another photographer's event of the same name: base + '-' + 6 base36 characters.
        const second = await folderShare(api, 'bangkok marathon 2026');
        expect(second.share.slug).toMatch(/^bangkok-marathon-2026-[0-9a-z]{6}$/);
        // Slugs never change: renaming the folder keeps the link.
        await api.request('PATCH', apiPath(D.updateFolder, { id: first.folder.id }), {
          token: first.owner.token,
          body: { name: 'Renamed' },
        });
        const listed = await api.request<{ items: { slug: string }[] }>('GET', apiPath(S.list), {
          token: first.owner.token,
        });
        expect(listed.body.items[0]?.slug).toBe('bangkok-marathon-2026');
      });

      it('handles Thai, file names, emoji-only and token-shaped names', async () => {
        const thai = await folderShare(api, 'งานวิ่ง กรุงเทพ 2026');
        expect(thai.share.slug).toBe('งานวิ่ง-กรุงเทพ-2026');
        expect(thai.share.path).toBe(`/s/${encodeURIComponent('งานวิ่ง-กรุงเทพ-2026')}`);
        const emoji = await folderShare(api, '🎉🎉');
        expect(emoji.share.slug).toMatch(/^event(-[0-9a-z]{6})?$/);
        // 22 ASCII letters: token-shaped, so always suffixed.
        const tokenish = await folderShare(api, 'AbcdefghijKlmnopqrstUv');
        expect(tokenish.share.slug).toMatch(/^abcdefghijklmnopqrstuv-[0-9a-z]{6}$/);
        // File shares use the name without its extension.
        const owner = await api.photographer();
        const file = await api.file(owner.id, null, 'IMG_1234.JPG');
        const res = await api.request('POST', apiPath(S.create), {
          token: owner.token,
          body: { target: { type: 'file', fileId: file.id } },
        });
        expect(ownerShareSchema.parse(res.body).slug).toMatch(/^img-1234(-[0-9a-z]{6})?$/);
      });
    });

    describe('refs: slug or token', () => {
      it('resolves both, case-insensitively and percent-encoded, to the same share', async () => {
        const { share } = await folderShare(api, 'งานวิ่ง Refs');
        const slug = share.slug ?? '';
        for (const ref of [slug, share.token, slug.replace('refs', 'REFS')]) {
          const res = await api.request('GET', publicPath(ref));
          expect(res.status, ref).toBe(200);
          expect(shareMetaResponseSchema.parse(res.body)).toMatchObject({
            token: share.token,
            slug,
            path: share.path,
          });
        }
        for (const ref of ['no-such-event', 'Z'.repeat(22), '%E0%B8', 'a/b']) {
          const res = await api.request('GET', publicPath(ref));
          expect(res.status, ref).toBe(404);
          expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
        }
      });

      it('sets the unlock cookie on the token path when unlocked through the slug', async () => {
        const { share } = await folderShare(api, 'Locked Event', { password: 'pin-4321' });
        const browser = api.browser();
        const unlock = await browser.request('POST', `${publicPath(share.slug ?? '')}/unlock`, {
          body: { password: 'pin-4321' },
        });
        expect(unlock.status).toBe(204);
        expect(unlock.headers.getSetCookie().join(';')).toContain(`Path=/api/s/${share.token}`);
        const meta = shareMetaResponseSchema.parse(
          (await browser.request('GET', apiPath(P.meta, { token: share.token }))).body,
        );
        expect(meta.access.locked).toBe(false);
      });

      it('throttles slug guessing per IP; token lookups keep working', async () => {
        const { share } = await folderShare(guarded, 'Guarded Event');
        // Found slugs count towards SHARE_SLUG_RESOLVE_RATE_PER_IP only.
        expect((await guarded.request('GET', publicPath(share.slug ?? ''))).status).toBe(200);
        // Three misses (unknown slug, unknown token, malformed ref) reach the NOT_FOUND limit.
        for (const ref of ['guess-one', 'Q'.repeat(22), '%E0%B8']) {
          expect((await guarded.request('GET', publicPath(ref))).status).toBe(404);
        }
        // Now every slug lookup is RATE_LIMITED, found or not, so guessing tells nothing.
        for (const ref of [share.slug ?? '', 'guess-two']) {
          const res = await guarded.request('GET', publicPath(ref));
          expect(res.status, ref).toBe(429);
          expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
          expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
        }
        // Tokens are exempt.
        expect((await guarded.request('GET', publicPath(share.token))).status).toBe(200);
        // After the window the slug resolves again.
        guarded.clock.advance(guarded.config.share.rateLimits.notFoundPerIp.windowSeconds * 1000);
        expect((await guarded.request('GET', publicPath(share.slug ?? ''))).status).toBe(200);
      });

      it('limits slug resolutions per IP even when every one is found', async () => {
        guarded.clock.advance(3600_000);
        const { share } = await folderShare(guarded, 'Busy Event');
        const limit = guarded.config.share.rateLimits.slugResolvePerIp.limit;
        for (let i = 0; i < limit; i++) {
          expect((await guarded.request('GET', publicPath(share.slug ?? ''))).status).toBe(200);
        }
        expect((await guarded.request('GET', publicPath(share.slug ?? ''))).status).toBe(429);
        expect((await guarded.request('GET', publicPath(share.token))).status).toBe(200);
      });
    });

    describe('folder cover', () => {
      it('validates the cover in the update transaction (COVER_FILE_INVALID reasons)', async () => {
        const owner = await api.photographer();
        const folder = await api.folder(owner.id, { name: 'Cover' });
        const sub = await api.folder(owner.id, { name: 'Sub', parent: folder });
        const elsewhere = await api.folder(owner.id, { name: 'Elsewhere' });
        const patch = (coverFileId: string | null) =>
          api.request('PATCH', apiPath(D.updateFolder, { id: folder.id }), {
            token: owner.token,
            body: { coverFileId },
          });
        const reason = async (coverFileId: string) => {
          const res = await patch(coverFileId);
          expect(res.status).toBe(422);
          return (res.body as { code: string; details: { reason: string } }).details.reason;
        };
        const trashed = await api.file(owner.id, folder.id);
        await api.db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, trashed.id));
        expect(await reason(trashed.id)).toBe('not_live');
        const processing = await api.file(owner.id, folder.id);
        await api.db.update(files).set({ status: 'processing' }).where(eq(files.id, processing.id));
        expect(await reason(processing.id)).toBe('not_ready');
        const video = await api.file(owner.id, folder.id, 'clip.mp4');
        await api.db.update(files).set({ mime: 'video/mp4' }).where(eq(files.id, video.id));
        expect(await reason(video.id)).toBe('not_image');
        const outside = await api.file(owner.id, elsewhere.id);
        expect(await reason(outside.id)).toBe('outside_folder');
        const atRoot = await api.file(owner.id, null);
        expect(await reason(atRoot.id)).toBe('outside_folder');
        // Another photographer's file is NOT_FOUND, like any foreign id.
        const other = await api.photographer();
        const foreign = await api.file(other.id, null);
        expect((await patch(foreign.id)).status).toBe(404);
        const [unchanged] = await api.db.select().from(folders).where(eq(folders.id, folder.id));
        expect(unchanged?.coverFileId).toBeNull();

        // A ready image in a subfolder is fine; null returns to the default.
        const inSub = await api.file(owner.id, sub.id);
        const ok = await patch(inSub.id);
        expect(ok.status).toBe(200);
        expect(driveFolderSchema.parse(ok.body).coverFileId).toBe(inSub.id);
        expect(driveFolderSchema.parse((await patch(null)).body).coverFileId).toBeNull();
      });

      it('share meta uses the chosen cover while it is a live image in scope, else the first', async () => {
        const { owner, folder, file: first, share } = await folderShare(api, 'Cover Meta');
        const chosen = await api.file(owner.id, folder.id);
        await api.request('PATCH', apiPath(D.updateFolder, { id: folder.id }), {
          token: owner.token,
          body: { coverFileId: chosen.id },
        });
        const coverUrl = async () =>
          shareMetaResponseSchema.parse((await api.request('GET', publicPath(share.token))).body)
            .details?.cover?.previewUrl ?? '';
        expect(await coverUrl()).toContain(chosen.id);
        // Trashed later: back to the first image (the column isn't cleared).
        await api.db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, chosen.id));
        expect(await coverUrl()).toContain(first.id);
      });
    });

    describe('folders and consent', () => {
      it('creates folders with face indexing on and the configured expiry', async () => {
        const owner = await api.photographer();
        const res = await api.request('POST', apiPath(D.createFolder), {
          token: owner.token,
          body: { name: 'New Event', parentId: null },
        });
        const days = api.config.retention.faceIndexExpiryDays;
        expect(driveFolderSchema.parse(res.body)).toMatchObject({
          faceIndexEnabled: true,
          faceIndexExpiresAt: new Date(api.clock.now().getTime() + days * 86_400_000).toISOString(),
          coverFileId: null,
        });
      });

      it('stores the consent locale; the first acceptance keeps its language', async () => {
        const { share } = await folderShare(api, 'Consent Locale');
        const browser = api.browser();
        const consent = (locale?: string) =>
          browser.request('POST', `${publicPath(share.slug ?? '')}/consent`, {
            body: {
              purpose: 'face_deletion',
              policyVersion: api.config.consent.policyVersion,
              accepted: true,
              ...(locale === undefined ? {} : { locale }),
            },
          });
        const first = await consent('en');
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ purpose: 'face_deletion', locale: 'en' });
        expect((await consent('zh')).body).toMatchObject({ locale: 'en' });
        const [row] = await api.db.select().from(consents).where(eq(consents.shareId, share.id));
        expect(row?.locale).toBe('en');
        expect((await consent('fr')).status).toBe(400);
        // Without a locale: Thai (clients from before ADR 0011).
        const other = api.browser();
        const thai = await other.request('POST', `${publicPath(share.token)}/consent`, {
          body: {
            purpose: 'face_deletion',
            policyVersion: api.config.consent.policyVersion,
            accepted: true,
          },
        });
        expect(thai.body).toMatchObject({ locale: 'th' });
        const [stored] = await api.db.select().from(shares).where(eq(shares.id, share.id));
        expect(stored?.slug).toBe(share.slug);
      });
    });
  });
}
