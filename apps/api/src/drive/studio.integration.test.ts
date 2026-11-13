import { randomUUID } from 'node:crypto';
import {
  activityEvents,
  dailyStats,
  files,
  folders,
  storageUsage,
  zipJobEntries,
  zipJobs,
} from '@shotx/db';
import {
  apiPath,
  copyFileResponseSchema,
  DRIVE_ROUTES as R,
  downloadFolderResponseSchema,
  driveStatsResponseSchema,
  folderSummaryResponseSchema,
  getFileResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  listRecentResponseSchema,
  ownerZipJobResponseSchema,
  searchDriveResponseSchema,
  zipKey,
} from '@shotx/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';
import { insertReadyFile } from '../testing/seed';

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`studio routes on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, {
        env: {
          QUEUE_BACKEND: 'bullmq',
          DRIVE_SEARCH_PAGE_SIZE: '2',
          DRIVE_SEARCH_MAX_RESULTS: '3',
          DRIVE_RECENT_PAGE_SIZE: '2',
          DRIVE_ZIP_MAX_ACTIVE_JOBS: '2',
          DRIVE_COPY_RATE_PER_USER: '1000',
          ZIP_MAX_FILES: '3',
          WORKER_ZIP_MAX_PROCESSING_SECONDS: '3600',
        },
      });
    }, 120_000);
    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    type Me = Awaited<ReturnType<TestApi['photographer']>>;
    const get = <T>(me: Me, path: string) => api.request<T>('GET', path, { token: me.token });
    const copy = (me: Me, id: string, body: Record<string, unknown>) =>
      api.request('POST', apiPath(R.copyFile, { id }), { token: me.token, body });
    const file = (
      me: Me,
      name: string,
      extra: Parameters<typeof insertReadyFile>[2] | object = {},
    ) => insertReadyFile(api.db, me.id, { name, ...extra });

    describe('POST /drive/files/:id/copy', () => {
      it('copies a ready file: processing, reserved bytes, source metadata, file.copy sent', async () => {
        const me = await api.photographer({ quotaBytes: 100_000 });
        const folder = await api.folder(me.id, { name: 'Event' });
        const source = await file(me, 'IMG_1.jpg', {
          folderId: folder.id,
          sizeBytes: 3000,
          sha256: 'a'.repeat(64),
          width: 4000,
          height: 3000,
          takenAt: new Date('2026-10-01T03:00:00Z'),
          webSizeBytes: 500,
        });
        const res = await copy(me, source.id, { targetFolderId: folder.id });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const copied = copyFileResponseSchema.parse(res.body);
        expect(copied).toMatchObject({
          name: 'IMG_1 (2).jpg',
          folderId: folder.id,
          status: 'processing',
          sizeBytes: 3000,
          width: 4000,
          takenAt: '2026-10-01T03:00:00.000Z',
        });
        expect(copied.thumbUrl).toBeUndefined();
        const [row] = await api.db.select().from(files).where(eq(files.id, copied.id));
        expect(row).toMatchObject({
          copiedFromFileId: source.id,
          sha256: 'a'.repeat(64),
          webSizeBytes: 500,
          thumbKey: null,
          verifiedAt: null,
          mediaQueuedAt: api.clock.now(),
        });
        // Keyed like uploads: the requested name, sanitized (the display name is separate).
        expect(row?.s3Key).toBe(`originals/${me.id}/${copied.id}/IMG_1.jpg`);
        expect(await api.usage(me.id)).toMatchObject({ usedBytes: 3000, reservedBytes: 3000 });
        expect(api.queue.messages('media')).toContainEqual({
          kind: 'file.copy',
          fileId: copied.id,
          sourceFileId: source.id,
          photographerId: me.id,
        });
        // To the root, with a new name; `fail` on a taken name.
        const renamed = await copy(me, source.id, { targetFolderId: null, name: 'สำเนา.jpg' });
        expect(renamed.body).toMatchObject({ name: 'สำเนา.jpg', folderId: null });
        const taken = await copy(me, source.id, {
          targetFolderId: folder.id,
          onNameConflict: 'fail',
        });
        expect(taken.body).toMatchObject({ code: 'NAME_TAKEN' });
        expect(
          (await copy(me, source.id, { targetFolderId: null, name: 'x.png' })).body,
        ).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
      });

      it('refuses over quota, inactive subscriptions, non-ready and foreign files', async () => {
        const me = await api.photographer({ quotaBytes: 5000 });
        const big = await file(me, 'big.jpg', { sizeBytes: 3000 });
        const res = await copy(me, big.id, { targetFolderId: null });
        expect(res.body).toMatchObject({
          code: 'QUOTA_EXCEEDED',
          details: { quotaBytes: 5000, usedBytes: 3000, requestedBytes: 3000 },
        });
        expect(await api.usage(me.id)).toMatchObject({ reservedBytes: 0 });

        const processing = await file(me, 'p.jpg', { status: 'processing', sizeBytes: 10 });
        expect((await copy(me, processing.id, { targetFolderId: null })).body).toMatchObject({
          code: 'CONFLICT',
        });
        const trashed = await file(me, 't.jpg', { deletedAt: new Date(), sizeBytes: 10 });
        expect((await copy(me, trashed.id, { targetFolderId: null })).status).toBe(404);

        const other = await api.photographer();
        const theirs = await file(other, 'theirs.jpg', { sizeBytes: 10 });
        const theirFolder = await api.folder(other.id);
        expect((await copy(me, theirs.id, { targetFolderId: null })).status).toBe(404);
        const mine = await file(me, 'mine.jpg', { sizeBytes: 10 });
        expect((await copy(me, mine.id, { targetFolderId: theirFolder.id })).status).toBe(404);

        const lapsed = await api.photographer({ status: 'expired' });
        const old = await file(lapsed, 'old.jpg', { sizeBytes: 10 });
        expect((await copy(lapsed, old.id, { targetFolderId: null })).body).toMatchObject({
          code: 'SUBSCRIPTION_INACTIVE',
        });
      });

      it('keeps faces_withheld_at on copies of withheld sources only', async () => {
        const me = await api.photographer();
        const withheldAt = new Date('2026-10-20T00:00:00Z');
        const withheld = await file(me, 'w.jpg', { sizeBytes: 10, facesWithheldAt: withheldAt });
        const normal = await file(me, 'n.jpg', { sizeBytes: 10 });
        const copyOf = async (id: string) => {
          const res = await copy(me, id, { targetFolderId: null });
          expect(res.status).toBe(201);
          const [row] = await api.db
            .select()
            .from(files)
            .where(eq(files.id, (res.body as { id: string }).id));
          return row;
        };
        expect((await copyOf(withheld.id))?.facesWithheldAt).toEqual(withheldAt);
        expect((await copyOf(normal.id))?.facesWithheldAt).toBeNull();
      });

      it('is idempotent per clientCopyId', async () => {
        const me = await api.photographer();
        const source = await file(me, 'a.jpg', { sizeBytes: 100 });
        const clientCopyId = randomUUID();
        const first = await copy(me, source.id, { targetFolderId: null, clientCopyId });
        const again = await copy(me, source.id, { targetFolderId: null, clientCopyId });
        expect(again.status).toBe(201);
        expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
        expect(await api.usage(me.id)).toMatchObject({ reservedBytes: 100 });
        const folder = await api.folder(me.id);
        expect(
          (await copy(me, source.id, { targetFolderId: folder.id, clientCopyId })).body,
        ).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });
    });

    describe('owner folder zips', () => {
      it('zips the ready, live subtree with its folder structure; polls with one owner event', async () => {
        const me = await api.photographer();
        const root = await api.folder(me.id, { name: 'งานแต่ง' });
        const day = await api.folder(me.id, { name: 'Day 1', parent: root });
        const gone = await api.folder(me.id, { name: 'Gone', parent: root });
        await file(me, 'a.jpg', { folderId: root.id, sizeBytes: 10 });
        await file(me, 'A.JPG', { folderId: day.id, sizeBytes: 20 });
        await file(me, 'a.jpg', { folderId: day.id, sizeBytes: 30, deletedAt: new Date() });
        await file(me, 'up.jpg', { folderId: day.id, status: 'processing', sizeBytes: 5 });
        await file(me, 'x.jpg', { folderId: gone.id, sizeBytes: 5 });
        await api.db.update(folders).set({ deletedAt: new Date() }).where(eq(folders.id, gone.id));

        const key = `zip-${randomUUID()}`;
        const res = await api.request('POST', apiPath(R.downloadFolder, { id: root.id }), {
          token: me.token,
          body: {},
          headers: { [IDEMPOTENCY_KEY_HEADER]: key },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const { job } = downloadFolderResponseSchema.parse(res.body);
        expect(job).toMatchObject({ status: 'queued', fileCount: 2, totalBytes: 30 });
        const [row] = await api.db.select().from(zipJobs).where(eq(zipJobs.id, job.id));
        expect(row).toMatchObject({
          shareId: null,
          viewerId: me.id,
          anonId: null,
          archiveName: 'งานแต่ง.zip',
          sourceFolderId: root.id,
          downloadSize: 'original',
        });
        const entries = await api.db
          .select({ name: zipJobEntries.name })
          .from(zipJobEntries)
          .where(eq(zipJobEntries.jobId, job.id))
          .orderBy(asc(zipJobEntries.position));
        expect(entries.map((e) => e.name).sort()).toEqual(['Day 1/A.JPG', 'a.jpg']);
        expect(api.queue.messages('zip')).toContainEqual({ type: 'zip.create', jobId: job.id });

        // Same key: the same job; same key, other size: reused.
        const again = await api.request('POST', apiPath(R.downloadFolder, { id: root.id }), {
          token: me.token,
          body: {},
          headers: { [IDEMPOTENCY_KEY_HEADER]: key },
        });
        expect(downloadFolderResponseSchema.parse(again.body).job.id).toBe(job.id);
        const other = await api.request('POST', apiPath(R.downloadFolder, { id: root.id }), {
          token: me.token,
          body: { size: 'web' },
          headers: { [IDEMPOTENCY_KEY_HEADER]: key },
        });
        expect(other.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

        // Ready: the signed URL under the archive name, and one owner zip event.
        const now = api.clock.now();
        await api.db
          .update(zipJobs)
          .set({
            status: 'ready',
            startedAt: now,
            completedAt: now,
            resultKey: zipKey(job.id),
            resultBytes: 4242,
            expiresAt: new Date(now.getTime() + 86_400_000),
          })
          .where(eq(zipJobs.id, job.id));
        const poll = () => get(me, apiPath(R.ownerZipJob, { id: job.id }));
        const ready = ownerZipJobResponseSchema.parse((await poll()).body);
        expect(ready.download?.fileName).toBe('งานแต่ง.zip');
        expect(ready.download?.url).toContain('https://');
        await poll();
        const events = await api.db
          .select()
          .from(activityEvents)
          .where(and(eq(activityEvents.photographerId, me.id), eq(activityEvents.type, 'zip')));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ source: 'owner', shareId: null, bytes: 4242 });

        // Another owner's job is NOT_FOUND.
        const stranger = await api.photographer();
        expect((await get(stranger, apiPath(R.ownerZipJob, { id: job.id }))).status).toBe(404);
        expect(
          (
            await api.request('POST', apiPath(R.downloadFolder, { id: root.id }), {
              token: stranger.token,
              body: {},
            })
          ).status,
        ).toBe(404);
      });

      it('refuses empty folders, too large zips and too many active jobs', async () => {
        const me = await api.photographer();
        const empty = await api.folder(me.id);
        const zip = (id: string, body: unknown = {}) =>
          api.request('POST', apiPath(R.downloadFolder, { id }), { token: me.token, body });
        expect((await zip(empty.id)).body).toMatchObject({ code: 'CONFLICT' });
        const folder = await api.folder(me.id);
        await file(me, 'big.jpg', { folderId: folder.id, sizeBytes: 3 * 1024 ** 3 });
        expect((await zip(folder.id)).body).toMatchObject({ code: 'ZIP_TOO_LARGE' });
        const small = await api.folder(me.id);
        await file(me, 's.jpg', { folderId: small.id, sizeBytes: 1 });
        expect((await zip(small.id)).status).toBe(202);
        expect((await zip(small.id)).status).toBe(202);
        const limited = await zip(small.id);
        expect(limited.status).toBe(429);
        expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });

        // Jobs older than WORKER_ZIP_MAX_PROCESSING_SECONDS (3600 here) no longer count: a lost
        // zip.create can't lock the photographer out. A running job started recently does.
        api.clock.advance(3_601_000);
        const fresh = await zip(small.id);
        expect(fresh.status).toBe(202);
        const id = downloadFolderResponseSchema.parse(fresh.body).job.id;
        await api.db
          .update(zipJobs)
          .set({ status: 'running', startedAt: api.clock.now() })
          .where(eq(zipJobs.id, id));
        expect((await zip(small.id)).status).toBe(202);
        expect((await zip(small.id)).status).toBe(429);
      });

      it('fails the job when zip.create cannot be sent, so it never counts as active', async () => {
        const me = await api.photographer();
        const folder = await api.folder(me.id);
        await file(me, 'a.jpg', { folderId: folder.id, sizeBytes: 1 });
        const zip = () =>
          api.request('POST', apiPath(R.downloadFolder, { id: folder.id }), {
            token: me.token,
            body: {},
          });
        api.queue.failing = true;
        try {
          expect((await zip()).status).toBe(500);
          expect((await zip()).status).toBe(500);
        } finally {
          api.queue.failing = false;
        }
        const jobs = await api.db.select().from(zipJobs).where(eq(zipJobs.photographerId, me.id));
        expect(jobs.map((j) => [j.status, j.errorCode])).toEqual([
          ['failed', 'INTERNAL_ERROR'],
          ['failed', 'INTERNAL_ERROR'],
        ]);
        expect((await zip()).status).toBe(202);
        expect((await zip()).status).toBe(202);
      });

      it('counts files in SQL before loading them, and refuses paths too long for a zip', async () => {
        const me = await api.photographer();
        const many = await api.folder(me.id);
        for (let i = 0; i < 4; i++)
          await file(me, `f${i}.jpg`, { folderId: many.id, sizeBytes: 1 });
        const res = await api.request('POST', apiPath(R.downloadFolder, { id: many.id }), {
          token: me.token,
          body: {},
        });
        expect(res.body).toMatchObject({
          code: 'ZIP_TOO_LARGE',
          details: { maxFiles: 3, files: 4, bytes: 4 },
        });

        // Five levels of long Thai names: each segment ~255 bytes, the path over 1024 bytes.
        const top = await api.folder(me.id, { name: 'ราก' });
        let parent = top;
        for (let level = 0; level < 5; level++) {
          parent = await api.folder(me.id, { name: 'ก'.repeat(100), parent });
        }
        await file(me, 'deep.jpg', { folderId: parent.id, sizeBytes: 1 });
        const deep = await api.request('POST', apiPath(R.downloadFolder, { id: top.id }), {
          token: me.token,
          body: {},
        });
        expect(deep.status).toBe(422);
        expect(deep.body).toMatchObject({ code: 'ZIP_TOO_LARGE', details: { files: 1 } });
      });
    });

    describe('GET /drive/recent', () => {
      it('lists live processing and ready files newest first, with cursors', async () => {
        const me = await api.photographer();
        const a = await file(me, 'a.jpg');
        await file(me, 'trash.jpg', { deletedAt: new Date() });
        await file(me, 'up.jpg', { status: 'uploading' });
        const b = await file(me, 'b.jpg', { status: 'processing' });
        const c = await file(me, 'c.jpg');
        const first = listRecentResponseSchema.parse((await get(me, apiPath(R.recent))).body);
        expect(first.items.map((i) => i.id)).toEqual([c.id, b.id]);
        const second = listRecentResponseSchema.parse(
          (await get(me, `${apiPath(R.recent)}?cursor=${first.nextCursor ?? ''}`)).body,
        );
        expect(second.items.map((i) => i.id)).toEqual([a.id]);
        expect(second.nextCursor).toBeNull();
        expect(first.items[0]?.thumbUrl).toContain('https://');
        const stranger = await api.photographer();
        expect(
          listRecentResponseSchema.parse((await get(stranger, apiPath(R.recent))).body).items,
        ).toEqual([]);
      });
    });

    describe('GET /drive/stats (ADR 0023)', () => {
      it('counts live photos per Bangkok day and share downloads from the rollup, own only', async () => {
        const me = await api.photographer();
        const now = api.clock.now();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now);
        const dayMs = 86_400_000;
        const longAgo = new Date(now.getTime() - 100 * dayMs);
        await file(me, 'a.jpg', { createdAt: now });
        await file(me, 'b.jpg', { createdAt: now, status: 'processing' });
        await file(me, 'old.jpg', { createdAt: longAgo });
        await file(me, 'clip.mp4', { createdAt: now, mime: 'video/mp4' });
        await file(me, 'gone.jpg', { createdAt: now, deletedAt: now });
        await file(me, 'up.jpg', { createdAt: now, status: 'uploading' });
        const other = await api.photographer();
        await file(other, 'x.jpg', { createdAt: now });
        const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(
          new Date(now.getTime() - dayMs),
        );
        await api.db.insert(dailyStats).values([
          { date: today, photographerId: me.id, downloads: 4 },
          { date: yesterday, photographerId: me.id, downloads: 2 },
          { date: '2020-01-01', photographerId: me.id, downloads: 10 },
          { date: today, photographerId: other.id, downloads: 99 },
        ]);

        const res = await get(me, `${apiPath(R.stats)}?days=7`);
        expect(res.status).toBe(200);
        const stats = driveStatsResponseSchema.parse(res.body);
        expect(stats.to).toBe(today);
        expect(stats.days).toHaveLength(7);
        expect(stats.days.at(-1)).toEqual({ date: today, photos: 2, downloads: 4 });
        expect(stats.days.at(-2)).toMatchObject({ date: yesterday, downloads: 2 });
        expect(stats.period).toEqual({ photos: 2, downloads: 6 });
        expect(stats.totals).toEqual({ photos: 3, downloads: 16 });

        // Default 30 days; other lengths are refused.
        const month = driveStatsResponseSchema.parse((await get(me, apiPath(R.stats))).body);
        expect(month.days).toHaveLength(30);
        expect((await get(me, `${apiPath(R.stats)}?days=8`)).status).toBe(400);
      });
    });

    describe('GET /drive/search', () => {
      it('finds names containing the text (ASCII case folded, Thai as typed), folders first', async () => {
        const me = await api.photographer();
        const wedding = await api.folder(me.id, { name: 'งานแต่ง สมชาย' });
        const inner = await api.folder(me.id, { name: 'Ceremony', parent: wedding });
        await file(me, 'ภาพงานแต่ง_01.jpg', { folderId: inner.id });
        await file(me, 'other.jpg', { folderId: inner.id });
        const stranger = await api.photographer();
        await file(stranger, 'งานแต่ง ของคนอื่น.jpg');

        const search = async (query: string, who = me) =>
          searchDriveResponseSchema.parse((await get(who, `${apiPath(R.search)}?${query}`)).body);
        const thai = await search(`q=${encodeURIComponent('งานแต่ง')}`);
        expect(thai.items.map((i) => i.item.name)).toEqual(['งานแต่ง สมชาย', 'ภาพงานแต่ง_01.jpg']);
        expect(thai.items[1]?.ancestors.map((a) => a.name)).toEqual(['งานแต่ง สมชาย', 'Ceremony']);
        const ascii = await search('q=CEREM');
        expect(ascii.items.map((i) => i.item.name)).toEqual(['Ceremony']);
        expect(ascii.items[0]?.ancestors.map((a) => a.name)).toEqual(['งานแต่ง สมชาย']);
        // LIKE wildcards are literal.
        expect((await search('q=%25')).items).toEqual([]);
        expect((await search(`q=${encodeURIComponent('_01')}`)).items).toHaveLength(1);
        // Subtree only (the folder itself is not a result); a foreign folder is NOT_FOUND.
        const below = await search(`folderId=${wedding.id}`);
        expect(below.items.map((i) => i.item.name)).toEqual(['Ceremony', 'other.jpg']);
        expect(below.truncated).toBe(false);
        expect(below.nextCursor).not.toBeNull();
        expect((await get(stranger, `${apiPath(R.search)}?folderId=${wedding.id}`)).status).toBe(
          404,
        );
      });

      it('filters by type, dates and trash, and caps the results', async () => {
        const me = await api.photographer();
        await api.folder(me.id, { name: 'clip folder' });
        await file(me, 'clip.mp4', {
          mime: 'video/mp4',
          takenAt: new Date('2026-05-01T00:00:00Z'),
        });
        await file(me, 'clip.jpg', { takenAt: new Date('2026-06-01T00:00:00Z') });
        await file(me, 'clip old.jpg', { deletedAt: new Date() });
        const search = async (query: string) =>
          searchDriveResponseSchema.parse((await get(me, `${apiPath(R.search)}?${query}`)).body);
        // A file-only criterion leaves folders out.
        expect((await search('q=clip&type=video')).items.map((i) => i.item.name)).toEqual([
          'clip.mp4',
        ]);
        expect(
          (
            await search('takenFrom=2026-05-15T00:00:00.000Z&takenTo=2026-07-01T00:00:00.000Z')
          ).items.map((i) => i.item.name),
        ).toEqual(['clip.jpg']);
        const all = await search('q=clip&includeTrashed=true');
        // DRIVE_SEARCH_PAGE_SIZE=2, DRIVE_SEARCH_MAX_RESULTS=3: 2 + 1, then truncated.
        expect(all.items).toHaveLength(2);
        const next = await search(`q=clip&includeTrashed=true&cursor=${all.nextCursor ?? ''}`);
        expect(next.items).toHaveLength(1);
        expect(next.truncated).toBe(true);
        expect(next.nextCursor).toBeNull();
        expect((await get(me, `${apiPath(R.search)}`)).status).toBe(400);
      });
    });

    describe('item info', () => {
      it('returns a file with its breadcrumbs, and a folder summary over the live subtree', async () => {
        const me = await api.photographer();
        const root = await api.folder(me.id, { name: 'Root' });
        const sub = await api.folder(me.id, { name: 'Sub', parent: root });
        const f = await file(me, 'a.jpg', { folderId: sub.id, sizeBytes: 100 });
        await file(me, 'v.mp4', { folderId: root.id, mime: 'video/mp4', sizeBytes: 50 });
        await file(me, 'trashed.jpg', { folderId: sub.id, sizeBytes: 999, deletedAt: new Date() });
        await file(me, 'up.jpg', { folderId: sub.id, sizeBytes: 999, status: 'uploading' });

        const info = getFileResponseSchema.parse(
          (await get(me, apiPath(R.getFile, { id: f.id }))).body,
        );
        expect(info.ancestors.map((a) => a.name)).toEqual(['Root', 'Sub']);
        expect(info.file.id).toBe(f.id);
        const summary = folderSummaryResponseSchema.parse(
          (await get(me, apiPath(R.folderSummary, { id: root.id }))).body,
        );
        expect(summary).toMatchObject({
          fileCount: 2,
          imageCount: 1,
          videoCount: 1,
          folderCount: 1,
          totalBytes: 150,
          ancestors: [],
        });
        const stranger = await api.photographer();
        expect((await get(stranger, apiPath(R.getFile, { id: f.id }))).status).toBe(404);
        expect((await get(stranger, apiPath(R.folderSummary, { id: root.id }))).status).toBe(404);
      });
    });
  });
}

describe('copies on QUEUE_BACKEND=sqs (AWS stacks)', () => {
  let database: TestDatabase;
  let api: TestApi;
  beforeAll(async () => {
    database = await DATABASE_BACKENDS[0].open();
    api = await TestApi.start(database.db);
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('sends no file.copy (media.sweep starts it) but stamps media_queued_at', async () => {
    const me = await api.photographer();
    const source = await insertReadyFile(api.db, me.id, { name: 'a.jpg', sizeBytes: 10 });
    const res = await api.request('POST', apiPath(R.copyFile, { id: source.id }), {
      token: me.token,
      body: { targetFolderId: null },
    });
    expect(res.status).toBe(201);
    expect(api.queue.messages('media')).toEqual([]);
    const [row] = await api.db
      .select()
      .from(files)
      .where(and(eq(files.ownerId, me.id), isNull(files.thumbKey)));
    expect(row?.mediaQueuedAt).not.toBeNull();
    const [usage] = await api.db
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.photographerId, me.id));
    expect(usage?.reservedBytes).toBe(10);
  });
});

describe('search rate limit (per photographer)', () => {
  let database: TestDatabase;
  let api: TestApi;
  beforeAll(async () => {
    database = await DATABASE_BACKENDS[0].open();
    api = await TestApi.start(database.db, { env: { DRIVE_COPY_RATE_PER_USER: '2' } });
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('answers RATE_LIMITED past the drive action rate', async () => {
    const me = await api.photographer();
    const search = () => api.request('GET', `${apiPath(R.search)}?q=x`, { token: me.token });
    expect((await search()).status).toBe(200);
    expect((await search()).status).toBe(200);
    const limited = await search();
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
    // Another photographer has their own budget.
    const other = await api.photographer();
    expect(
      (await api.request('GET', `${apiPath(R.search)}?q=x`, { token: other.token })).status,
    ).toBe(200);
  });
});
