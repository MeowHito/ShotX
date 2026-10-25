import { activityEvents, files, zipJobEntries, zipJobs } from '@shotx/db';
import {
  ANON_ID_COOKIE,
  apiPath,
  createDownloadResponseSchema,
  DRIVE_ROUTES,
  PUBLIC_SHARE_ROUTES as P,
  signedDownloadSchema,
  zipJobResponseSchema,
  zipKey,
} from '@shotx/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';

const downloads = (token: string) => apiPath(P.downloads, { token });
const zipJob = (id: string) => apiPath(P.zipJob, { id });
const KEY = 'idempotency-key';

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`downloads on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, {
        env: { ZIP_MAX_FILES: '3', ZIP_CREATE_RATE_PER_VIEWER: '4' },
      });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    async function shared(options: Parameters<TestApi['share']>[2] = {}) {
      const owner = await api.photographer();
      const root = await api.folder(owner.id, { name: 'งานวิ่ง' });
      const list = [];
      for (let i = 0; i < 4; i++) list.push(await api.file(owner.id, root.id, `ภาพ ${i}.JPG`));
      const share = await api.share(owner.id, { folderId: root.id }, options);
      return { owner, root, files: list, share };
    }

    describe('single file', () => {
      it('signs the web size with Content-Disposition attachment and logs a download', async () => {
        const {
          share,
          files: [f],
        } = await shared();
        const b = api.browser();
        const res = await b.request('POST', downloads(share.token), { body: { fileIds: [f?.id] } });
        expect(res.status).toBe(200);
        const body = createDownloadResponseSchema.parse(res.body);
        if (body.kind !== 'file') throw new Error('expected a file');
        expect(body.file.fileName).toBe('ภาพ 0.jpg');
        const url = new URL(body.file.url);
        expect(url.pathname).toMatch(/\/media\/derived\/.+\/web\.jpg$/);
        expect(url.searchParams.get('response-content-disposition')).toBe(
          `attachment; filename="___ 0.jpg"; filename*=UTF-8''%E0%B8%A0%E0%B8%B2%E0%B8%9E%200.jpg`,
        );
        expect(url.searchParams.get('Signature')).not.toBeNull();
        // Download TTL (10 min) rounded up to the 5-minute bucket.
        const left = (Date.parse(body.file.expiresAt) - api.clock.now().getTime()) / 1000;
        expect(left).toBeGreaterThanOrEqual(api.config.share.signedUrlTtlSeconds.download);
        expect(left).toBeLessThanOrEqual(
          api.config.share.signedUrlTtlSeconds.download +
            api.config.share.signedUrlExpiryBucketSeconds,
        );
        const [event] = await api.db
          .select()
          .from(activityEvents)
          .where(and(eq(activityEvents.shareId, share.id), eq(activityEvents.type, 'download')));
        expect(event).toMatchObject({
          source: 'share',
          fileId: f?.id,
          bytes: 500,
          anonId: b.cookie(ANON_ID_COOKIE),
          meta: null,
        });
      });

      it('serves originals only when the share says so', async () => {
        const {
          share,
          files: [f],
        } = await shared({ downloadSize: 'original' });
        const res = await api.request('POST', downloads(share.token), {
          body: { fileIds: [f?.id] },
        });
        const body = createDownloadResponseSchema.parse(res.body);
        if (body.kind !== 'file') throw new Error('expected a file');
        expect(new URL(body.file.url).pathname).toContain('/media/originals/');
      });

      it('is DOWNLOAD_NOT_ALLOWED on a view-only share', async () => {
        const {
          share,
          files: [f],
        } = await shared({ allowDownload: false });
        const res = await api.request('POST', downloads(share.token), {
          body: { fileIds: [f?.id] },
        });
        expect(res).toMatchObject({ status: 403, body: { code: 'DOWNLOAD_NOT_ALLOWED' } });
      });

      it('is NOT_FOUND for files outside the scope or of another photographer', async () => {
        const { share, owner, files: list } = await shared();
        const loose = await api.file(owner.id, null);
        const foreign = await api.file((await api.photographer()).id, null);
        const trashed = list[3];
        await api.trashFile(trashed?.id ?? '');
        for (const id of [loose.id, foreign.id, trashed?.id]) {
          const res = await api.request('POST', downloads(share.token), {
            body: { fileIds: [id] },
          });
          expect(res.status, id).toBe(404);
        }
        // One bad id fails the whole request.
        const mixed = await api.request('POST', downloads(share.token), {
          body: { fileIds: [list[0]?.id, loose.id] },
          headers: { [KEY]: 'mixed-1' },
        });
        expect(mixed.status).toBe(404);
      });
    });

    describe('zip', () => {
      it('requires an Idempotency-Key for more than one file', async () => {
        const { share, files: list } = await shared();
        const res = await api.request('POST', downloads(share.token), {
          body: { fileIds: [list[0]?.id, list[1]?.id] },
        });
        expect(res).toMatchObject({
          status: 400,
          body: {
            code: 'VALIDATION_FAILED',
            details: { issues: [{ path: ['headers', 'idempotency-key'] }] },
          },
        });
      });

      it('creates one job with entries and a zip.create message, idempotently', async () => {
        const { share, owner, files: list } = await shared();
        const b = api.browser();
        const ids = [list[0]?.id, list[1]?.id, list[2]?.id];
        const first = await b.request('POST', downloads(share.token), {
          body: { fileIds: ids },
          headers: { [KEY]: 'zip-key-1' },
        });
        expect(first.status).toBe(200);
        const body = createDownloadResponseSchema.parse(first.body);
        if (body.kind !== 'zip') throw new Error('expected a zip');
        expect(body.job).toMatchObject({
          status: 'queued',
          fileCount: 3,
          totalBytes: 1500,
          download: null,
        });
        const [job] = await api.db.select().from(zipJobs).where(eq(zipJobs.id, body.job.id));
        expect(job).toMatchObject({
          photographerId: owner.id,
          shareId: share.id,
          anonId: b.cookie(ANON_ID_COOKIE),
          downloadSize: 'web',
          idempotencyKey: 'zip-key-1',
        });
        const entries = await api.db
          .select()
          .from(zipJobEntries)
          .where(eq(zipJobEntries.jobId, body.job.id))
          .orderBy(asc(zipJobEntries.position));
        expect(entries.map((e) => [e.fileId, e.name])).toEqual([
          [ids[0], 'ภาพ 0.jpg'],
          [ids[1], 'ภาพ 1.jpg'],
          [ids[2], 'ภาพ 2.jpg'],
        ]);
        expect(api.queue.messages('zip')).toContainEqual({
          type: 'zip.create',
          jobId: body.job.id,
        });

        // Same key, same viewer, same files (any order): the same job.
        const again = await b.request('POST', downloads(share.token), {
          body: { fileIds: [...ids].reverse() },
          headers: { [KEY]: 'zip-key-1' },
        });
        expect(createDownloadResponseSchema.parse(again.body)).toMatchObject({
          kind: 'zip',
          job: { id: body.job.id },
        });
        expect(
          await api.db.select().from(zipJobs).where(eq(zipJobs.shareId, share.id)),
        ).toHaveLength(1);
        // Other files, or another viewer: IDEMPOTENCY_KEY_REUSED.
        const other = await b.request('POST', downloads(share.token), {
          body: { fileIds: [ids[0], ids[1]] },
          headers: { [KEY]: 'zip-key-1' },
        });
        expect(other).toMatchObject({ status: 422, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
        const stranger = await api.browser().request('POST', downloads(share.token), {
          body: { fileIds: ids },
          headers: { [KEY]: 'zip-key-1' },
        });
        expect(stranger.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });

      it('enforces ZIP_MAX_FILES with ZIP_TOO_LARGE', async () => {
        const { share, files: list } = await shared();
        const res = await api.request('POST', downloads(share.token), {
          body: { fileIds: list.map((f) => f.id) },
          headers: { [KEY]: 'too-many' },
        });
        expect(res).toMatchObject({
          status: 422,
          body: { code: 'ZIP_TOO_LARGE', details: { maxFiles: 3, files: 4, bytes: 2000 } },
        });
      });

      it('uses the original names for original-size zips, made unique ignoring case', async () => {
        const owner = await api.photographer();
        const root = await api.folder(owner.id);
        const sub = await api.folder(owner.id, { parent: root });
        const a = await api.file(owner.id, root.id, 'IMG_1.jpg');
        const b = await api.file(owner.id, sub.id, 'img_1.JPG');
        const s = await api.share(owner.id, { folderId: root.id }, { downloadSize: 'original' });
        const res = await api.request('POST', downloads(s.token), {
          body: { fileIds: [a.id, b.id] },
          headers: { [KEY]: 'names' },
        });
        const body = createDownloadResponseSchema.parse(res.body);
        const entries = await api.db
          .select({ name: zipJobEntries.name })
          .from(zipJobEntries)
          .where(eq(zipJobEntries.jobId, body.kind === 'zip' ? body.job.id : ''))
          .orderBy(asc(zipJobEntries.position));
        expect(entries.map((e) => e.name)).toEqual(['IMG_1.jpg', 'img_1 (2).JPG']);
      });

      it('re-sends zip.create when a replay finds the job still queued', async () => {
        const { share, files: list } = await shared();
        const b = api.browser();
        api.queue.failing = true;
        const failed = await b.request('POST', downloads(share.token), {
          body: { fileIds: [list[0]?.id, list[1]?.id] },
          headers: { [KEY]: 'lost-send' },
        });
        api.queue.failing = false;
        expect(failed.status).toBe(500);
        const sent = api.queue.sent.length;
        const retry = await b.request('POST', downloads(share.token), {
          body: { fileIds: [list[0]?.id, list[1]?.id] },
          headers: { [KEY]: 'lost-send' },
        });
        expect(retry.status).toBe(200);
        expect(api.queue.sent.length).toBe(sent + 1);
      });

      it('serves the job to its creator only, with one zip event for the first URL', async () => {
        const { share, files: list } = await shared();
        const b = api.browser();
        const created = createDownloadResponseSchema.parse(
          (
            await b.request('POST', downloads(share.token), {
              body: { fileIds: [list[0]?.id, list[1]?.id] },
              headers: { [KEY]: 'poll' },
            })
          ).body,
        );
        if (created.kind !== 'zip') throw new Error('expected a zip');
        const id = created.job.id;
        expect((await b.request('GET', zipJob(id))).body).toMatchObject({
          status: 'queued',
          download: null,
        });
        expect((await api.browser().request('GET', zipJob(id))).status).toBe(404);

        // The worker finishes it.
        const now = api.clock.now();
        await api.db
          .update(zipJobs)
          .set({
            status: 'ready',
            startedAt: now,
            completedAt: now,
            resultKey: zipKey(id),
            resultBytes: 4242,
            expiresAt: new Date(now.getTime() + 86_400_000),
          })
          .where(eq(zipJobs.id, id));
        const ready = zipJobResponseSchema.parse((await b.request('GET', zipJob(id))).body);
        expect(ready.status).toBe('ready');
        expect(ready.download?.fileName).toBe('งานวิ่ง.zip');
        expect(new URL(ready.download?.url ?? '').pathname).toBe(`/media/tmp/zips/${id}.zip`);
        await b.request('GET', zipJob(id));
        const events = await api.db
          .select()
          .from(activityEvents)
          .where(and(eq(activityEvents.shareId, share.id), eq(activityEvents.type, 'zip')));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ bytes: 4242, meta: { files: 2 }, fileId: null });

        // Past expires_at the archive is gone.
        api.clock.advance(2 * 86_400_000);
        const expired = zipJobResponseSchema.parse((await b.request('GET', zipJob(id))).body);
        expect(expired).toMatchObject({ status: 'expired', download: null, availableUntil: null });
        api.clock.advance(-2 * 86_400_000);
      });

      it('checks the share again when polling', async () => {
        const { share, owner, files: list } = await shared();
        const b = api.browser();
        const created = createDownloadResponseSchema.parse(
          (
            await b.request('POST', downloads(share.token), {
              body: { fileIds: [list[0]?.id, list[1]?.id] },
              headers: { [KEY]: 'revoke' },
            })
          ).body,
        );
        if (created.kind !== 'zip') throw new Error('expected a zip');
        const revoke = await api.request('DELETE', `/api/shares/${share.id}`, {
          token: owner.token,
        });
        expect(revoke.status).toBe(204);
        expect((await b.request('GET', zipJob(created.job.id))).body).toMatchObject({
          code: 'SHARE_EXPIRED',
          details: { reason: 'revoked' },
        });
      });

      it('rate-limits new zip jobs per viewer, not replays', async () => {
        const { share, files: list } = await shared();
        const b = api.browser();
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
          const res = await b.request('POST', downloads(share.token), {
            body: { fileIds: [list[0]?.id, list[1]?.id] },
            headers: { [KEY]: `rl-${i}` },
          });
          statuses.push(res.status);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 429]);
        const replay = await b.request('POST', downloads(share.token), {
          body: { fileIds: [list[0]?.id, list[1]?.id] },
          headers: { [KEY]: 'rl-0' },
        });
        expect(replay.status).toBe(200);
      });
    });

    describe('owner download', () => {
      const path = (id: string, size?: string) =>
        `${apiPath(DRIVE_ROUTES.downloadFile, { id })}${size === undefined ? '' : `?size=${size}`}`;

      it('signs the original by default, with an owner download event', async () => {
        const owner = await api.photographer();
        const f = await api.file(owner.id, null, 'งาน.jpg');
        const res = await api.request('GET', path(f.id), { token: owner.token });
        expect(res.status).toBe(200);
        const body = signedDownloadSchema.parse(res.body);
        expect(body.fileName).toBe('งาน.jpg');
        expect(new URL(body.url).pathname).toContain('/media/originals/');
        expect(new URL(body.url).searchParams.get('response-content-disposition')).toContain(
          'attachment;',
        );
        const [event] = await api.db
          .select()
          .from(activityEvents)
          .where(and(eq(activityEvents.fileId, f.id), eq(activityEvents.source, 'owner')));
        expect(event).toMatchObject({
          type: 'download',
          shareId: null,
          viewerId: null,
          anonId: null,
          photographerId: owner.id,
          bytes: 1000,
        });
        const web = signedDownloadSchema.parse(
          (await api.request('GET', path(f.id, 'web'), { token: owner.token })).body,
        );
        expect(new URL(web.url).pathname).toMatch(/web\.jpg$/);
      });

      it('works in the trash and for expired subscriptions; CONFLICT until ready', async () => {
        const owner = await api.photographer({ status: 'expired' });
        const f = await api.file(owner.id, null);
        await api.trashFile(f.id);
        expect((await api.request('GET', path(f.id), { token: owner.token })).status).toBe(200);
        await api.db.update(files).set({ status: 'processing' }).where(eq(files.id, f.id));
        expect(
          (await api.request('GET', path(f.id, 'web'), { token: owner.token })).body,
        ).toMatchObject({
          code: 'CONFLICT',
        });
        await api.db.update(files).set({ status: 'uploading' }).where(eq(files.id, f.id));
        expect((await api.request('GET', path(f.id), { token: owner.token })).status).toBe(409);
      });

      it('is NOT_FOUND for another photographer', async () => {
        const owner = await api.photographer();
        const f = await api.file(owner.id, null);
        const other = await api.photographer();
        expect((await api.request('GET', path(f.id), { token: other.token })).status).toBe(404);
      });
    });
  });
}
