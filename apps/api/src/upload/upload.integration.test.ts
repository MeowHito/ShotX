import { files } from '@shotx/db';
import {
  apiPath,
  type CompleteUploadResponse,
  DRIVE_ROUTES,
  type DriveFolder,
  type ListPartsResponse,
  type SignPartsResponse,
  UPLOAD_ROUTES,
  type UploadInitBody,
  type UploadInitResponse,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';

const U = UPLOAD_ROUTES;
const MiB = 1024 * 1024;
const PART = 5 * MiB; // UPLOAD_PART_BYTES in testEnv

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`uploads on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, {
        limits: { uploadInitRate: { limit: 3, windowSeconds: 60 } },
      });
    });

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    type Me = Awaited<ReturnType<TestApi['photographer']>>;

    const init = (me: Me, body: Partial<UploadInitBody>) =>
      api.request<UploadInitResponse>('POST', apiPath(U.init), {
        token: me.token,
        body: { name: 'IMG_0001.JPG', size: 12 * MiB, mime: 'image/jpeg', folderId: null, ...body },
      });
    const complete = (me: Me, id: string, parts: { partNumber: number; etag: string }[]) =>
      api.request<CompleteUploadResponse>('POST', apiPath(U.complete, { id }), {
        token: me.token,
        body: { parts },
      });
    const abort = (me: Me, id: string) =>
      api.request('DELETE', apiPath(U.abort, { id }), { token: me.token });
    const row = async (id: string) =>
      (await api.db.select().from(files).where(eq(files.id, id)))[0];
    /** Uploads every part of the plan to the fake S3, as Uppy would. */
    const uploadParts = (res: UploadInitResponse, size: number) =>
      Array.from({ length: res.partCount }, (_, i) => {
        const partNumber = i + 1;
        const bytes =
          partNumber < res.partCount ? res.partSize : size - res.partSize * (res.partCount - 1);
        return { partNumber, etag: api.storage.putPart(res.uploadId, partNumber, bytes) };
      });

    it('init reserves quota, creates the row and opens a multipart upload', async () => {
      const me = await api.photographer({ quotaBytes: 100 * MiB });
      const res = await init(me, {});
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const body = res.body;
      expect(body).toMatchObject({
        partSize: PART,
        partCount: 3,
        maxConcurrency: 4,
        createdFolders: [],
        file: {
          kind: 'file',
          name: 'IMG_0001.JPG',
          status: 'uploading',
          mime: 'image/jpeg',
          mediaKind: 'image',
          sizeBytes: 12 * MiB,
        },
      });
      expect(body.parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(body.parts[0]?.url).toContain(`uploadId=${body.uploadId}`);
      expect(Date.parse(body.expiresAt) - api.clock.now().getTime()).toBe(24 * 3600 * 1000);
      const stored = await row(body.fileId);
      expect(stored).toMatchObject({
        ownerId: me.id,
        uploadId: body.uploadId,
        s3Key: `originals/${me.id}/${body.fileId}/IMG_0001.JPG`,
      });
      expect(await api.usage(me.id)).toMatchObject({ usedBytes: 0, reservedBytes: 12 * MiB });
    });

    it('rejects types off the allowlist (with the HEIC/RAW hint) and oversized files', async () => {
      const me = await api.photographer();
      const heic = await init(me, { name: 'IMG.HEIC', mime: 'image/heic' });
      expect(heic.status).toBe(415);
      expect(heic.body).toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
        details: { extension: 'heic', hint: 'heic' },
      });
      const mismatch = await init(me, { name: 'a.png', mime: 'image/jpeg' });
      expect(mismatch.body).toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
        details: { hint: null },
      });
      const big = await init(me, { size: 101 * MiB });
      expect(big.status).toBe(413);
      expect(big.body).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxBytes: 100 * MiB } });
      expect(api.storage.calls.filter((c) => c.includes(me.id))).toEqual([]);
    });

    it('is SUBSCRIPTION_INACTIVE in grace and QUOTA_EXCEEDED past the quota', async () => {
      const grace = await api.photographer({ status: 'grace' });
      const g = await init(grace, {});
      expect(g.status).toBe(403);
      expect(g.body).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE', details: { status: 'grace' } });

      const me = await api.photographer({ quotaBytes: 20 * MiB });
      expect((await init(me, { size: 12 * MiB })).status).toBe(201);
      const over = await init(me, { name: 'b.jpg', size: 9 * MiB });
      expect(over.status).toBe(403);
      expect(over.body).toMatchObject({
        code: 'QUOTA_EXCEEDED',
        details: {
          quotaBytes: 20 * MiB,
          reservedBytes: 12 * MiB,
          requestedBytes: 9 * MiB,
          availableBytes: 8 * MiB,
        },
      });
      expect(await api.usage(me.id)).toMatchObject({ reservedBytes: 12 * MiB });
    });

    it('creates relativePath folders once and reuses them; renames or fails on name conflicts', async () => {
      const me = await api.photographer();
      const first = await init(me, { name: 'a.jpg', relativePath: 'Event/Day 1' });
      expect(first.status).toBe(201);
      expect(first.body.createdFolders.map((f: DriveFolder) => f.name)).toEqual(['Event', 'Day 1']);
      const day1 = first.body.createdFolders[1];
      expect(first.body.file.folderId).toBe(day1?.id);
      const second = await init(me, { name: 'A.JPG', relativePath: 'event/Day 1' });
      expect(second.body.createdFolders).toEqual([]);
      expect(second.body.file).toMatchObject({ folderId: day1?.id, name: 'A (2).JPG' });
      const fail = await init(me, {
        name: 'a.jpg',
        relativePath: 'Event/Day 1',
        onNameConflict: 'fail',
      });
      expect(fail.status).toBe(409);
      expect(fail.body).toMatchObject({
        code: 'NAME_TAKEN',
        details: { kind: 'file', name: 'a.jpg' },
      });
      // The multipart upload opened for the failed init was aborted, and nothing stays reserved.
      expect(api.storage.calls.filter((c) => c.startsWith('abort'))).not.toHaveLength(0);
      expect(await api.usage(me.id)).toMatchObject({ reservedBytes: 24 * MiB });
    });

    it("can't upload into another photographer's folder", async () => {
      const owner = await api.photographer();
      const other = await api.photographer();
      const folder = await api.request<DriveFolder>('POST', apiPath(DRIVE_ROUTES.createFolder), {
        token: owner.token,
        body: { parentId: null, name: 'Mine' },
      });
      const res = await init(other, { folderId: folder.body.id });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rate-limits init per photographer', async () => {
      const me = await api.photographer();
      for (let i = 0; i < 3; i++)
        expect((await init(me, { name: `${i}.jpg`, size: 1 })).status).toBe(201);
      const limited = await init(me, { name: '4.jpg', size: 1 });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      // Another photographer has their own window.
      const other = await api.photographer();
      expect((await init(other, { size: 1 })).status).toBe(201);
    });

    it('signs and lists parts, within the plan', async () => {
      const me = await api.photographer();
      const res = (await init(me, {})).body;
      const signed = await api.request<SignPartsResponse>(
        'POST',
        apiPath(U.signParts, { id: res.fileId }),
        {
          token: me.token,
          body: { partNumbers: [3] },
        },
      );
      expect(signed.status).toBe(200);
      expect(signed.body.parts[0]?.partNumber).toBe(3);
      const tooFar = await api.request('POST', apiPath(U.signParts, { id: res.fileId }), {
        token: me.token,
        body: { partNumbers: [4] },
      });
      expect(tooFar.status).toBe(400);
      expect(tooFar.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { issues: [{ path: ['body', 'partNumbers', 0] }] },
      });
      api.storage.putPart(res.uploadId, 1, PART);
      const listed = await api.request<ListPartsResponse>(
        'GET',
        apiPath(U.listParts, { id: res.fileId }),
        {
          token: me.token,
        },
      );
      expect(listed.body.parts).toEqual([{ partNumber: 1, etag: `"etag-1-${PART}"`, size: PART }]);
      const other = await api.photographer();
      const foreign = await api.request('GET', apiPath(U.listParts, { id: res.fileId }), {
        token: other.token,
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    });

    it('completes only when the parts match the plan, and is idempotent', async () => {
      const me = await api.photographer();
      const size = 12 * MiB;
      const res = (await init(me, { size })).body;
      // A short middle part: the object would differ from the reservation.
      api.storage.putPart(res.uploadId, 1, PART);
      const shortEtag = api.storage.putPart(res.uploadId, 2, PART - 1);
      const lastEtag = api.storage.putPart(res.uploadId, 3, size - 2 * PART);
      const bad = await complete(me, res.fileId, [
        { partNumber: 1, etag: `"etag-1-${PART}"` },
        { partNumber: 2, etag: shortEtag },
        { partNumber: 3, etag: lastEtag },
      ]);
      expect(bad.status).toBe(422);
      expect(bad.body).toMatchObject({ code: 'UPLOAD_PARTS_INVALID' });

      const parts = uploadParts(res, size);
      const wrongEtag = await complete(
        me,
        res.fileId,
        parts.map((p) => ({ ...p, etag: '"nope"' })),
      );
      expect(wrongEtag.body).toMatchObject({ code: 'UPLOAD_PARTS_INVALID' });
      const missing = await complete(me, res.fileId, parts.slice(0, 2));
      expect(missing.body).toMatchObject({ code: 'UPLOAD_PARTS_INVALID' });

      // Unquoted ETags are fine too.
      const done = await complete(
        me,
        res.fileId,
        parts.map((p) => ({ ...p, etag: p.etag.replace(/"/g, '') })),
      );
      expect(done.status).toBe(200);
      expect(done.body.file).toMatchObject({ id: res.fileId, status: 'processing' });
      expect(api.storage.objects.get(`originals/${me.id}/${res.fileId}/IMG_0001.JPG`)?.size).toBe(
        size,
      );
      expect((await row(res.fileId))?.uploadId).toBeNull();
      // Bytes stay reserved until the worker verifies them.
      expect(await api.usage(me.id)).toMatchObject({ reservedBytes: size, usedBytes: 0 });

      const again = await complete(me, res.fileId, parts);
      expect(again.status).toBe(200);
      expect(again.body.file.status).toBe('processing');
      expect((await abort(me, res.fileId)).status).toBe(409);
    });

    it('recovers when S3 completed but the response was lost', async () => {
      const me = await api.photographer();
      const res = (await init(me, { size: 3 * MiB })).body;
      const parts = uploadParts(res, 3 * MiB);
      api.storage.failAfterNextComplete = true;
      expect((await complete(me, res.fileId, parts)).status).toBe(500);
      const retry = await complete(me, res.fileId, parts);
      expect(retry.status).toBe(200);
      expect(retry.body.file.status).toBe('processing');
    });

    it('answers UPLOAD_EXPIRED after the session ends', async () => {
      const me = await api.photographer();
      const res = (await init(me, { size: 1 })).body;
      const parts = uploadParts(res, 1);
      api.clock.advance(24 * 3600 * 1000);
      const late = await complete(me, res.fileId, parts);
      expect(late.status).toBe(410);
      expect(late.body).toMatchObject({ code: 'UPLOAD_EXPIRED' });
      api.clock.advance(-24 * 3600 * 1000);
    });

    it('abort releases the reservation and deletes the row', async () => {
      const me = await api.photographer();
      const keep = (await init(me, { name: 'keep.jpg', size: 2 * MiB })).body;
      const res = (await init(me, { size: 7 * MiB })).body;
      expect(await api.usage(me.id)).toMatchObject({ reservedBytes: 9 * MiB });
      const other = await api.photographer();
      expect((await abort(other, res.fileId)).status).toBe(404);
      const aborted = await abort(me, res.fileId);
      expect(aborted.status).toBe(204);
      expect(await row(res.fileId)).toBeUndefined();
      expect(api.storage.uploads.has(res.uploadId)).toBe(false);
      expect(await api.usage(me.id)).toMatchObject({ reservedBytes: 2 * MiB });
      const twice = await abort(me, res.fileId);
      expect(twice.status).toBe(404);
      expect(twice.body).toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
      void keep;
    });

    it.runIf(backend.name === 'TEST_DATABASE_URL')(
      'concurrent drops of one folder create it once',
      async () => {
        const racer = await TestApi.start(database.db);
        try {
          const me = await racer.photographer();
          const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
              racer.request<UploadInitResponse>('POST', apiPath(U.init), {
                token: me.token,
                body: {
                  name: `r${i}.jpg`,
                  size: 1,
                  mime: 'image/jpeg',
                  folderId: null,
                  relativePath: 'Race/Inner',
                },
              }),
            ),
          );
          expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
          expect(new Set(results.map((r) => r.body.file.folderId)).size).toBe(1);
          expect(
            results.flatMap((r) => r.body.createdFolders).filter((f) => f.name === 'Race'),
          ).toHaveLength(1);
        } finally {
          await racer.close();
        }
      },
    );

    it.runIf(backend.name === 'TEST_DATABASE_URL')(
      'never over-reserves under concurrent inits (guarded statement)',
      async () => {
        // Its own app: the suite's rate limit (3 per minute) would hide the quota race.
        const racer = await TestApi.start(database.db);
        try {
          const me = await racer.photographer({ quotaBytes: 10 * MiB });
          const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
              racer.request('POST', apiPath(U.init), {
                token: me.token,
                body: { name: `c${i}.jpg`, size: 4 * MiB, mime: 'image/jpeg', folderId: null },
              }),
            ),
          );
          expect(results.map((r) => r.status).sort()).toEqual([201, 201, 403, 403, 403, 403]);
          expect((await racer.usage(me.id)).reservedBytes).toBe(8 * MiB);
        } finally {
          await racer.close();
        }
      },
    );

    describe('upload_part_bytes', () => {
      it('is stored with upload_id, used by signParts and complete, and cleared on complete', async () => {
        const me = await api.photographer({ quotaBytes: 100 * MiB });
        const res = (await init(me, {})).body;
        expect(await row(res.fileId)).toMatchObject({ uploadPartBytes: PART });
        // The setting changes after init: the stored plan still decides.
        const changed = await TestApi.start(database.db, {
          env: { UPLOAD_PART_BYTES: String(8 * MiB) },
        });
        try {
          const signed = await changed.request<SignPartsResponse>(
            'POST',
            apiPath(U.signParts, { id: res.fileId }),
            { token: await changed.auth.token('users', me.sub), body: { partNumbers: [3] } },
          );
          // With 8 MiB parts there would be only 2 parts.
          expect(signed.status).toBe(200);
        } finally {
          await changed.close();
        }
        const done = await complete(me, res.fileId, uploadParts(res, 12 * MiB));
        expect(done.status).toBe(200);
        expect(await row(res.fileId)).toMatchObject({ uploadId: null, uploadPartBytes: null });
      });
    });

    describe('clientUploadId', () => {
      const clientUploadId = '6b3f0a52-9a43-4c8e-9a4e-3d1e7f4b2c10';
      const nextWindow = () => api.clock.advance(61_000);

      it('replays an open upload: same file, fresh part URLs, no second reservation', async () => {
        nextWindow();
        const me = await api.photographer({ quotaBytes: 100 * MiB });
        const first = await init(me, { clientUploadId, relativePath: 'Day 1' });
        expect(first.status).toBe(201);
        expect(first.body.createdFolders).toHaveLength(1);
        api.clock.advance(1000);
        const again = await init(me, { clientUploadId, relativePath: 'Day 1' });
        expect(again.status).toBe(201);
        expect(again.body).toMatchObject({
          fileId: first.body.fileId,
          uploadId: first.body.uploadId,
          partSize: first.body.partSize,
          partCount: first.body.partCount,
          expiresAt: first.body.expiresAt,
          createdFolders: [],
        });
        expect(again.body.parts.map((p) => p.partNumber)).toEqual([1, 2]);
        expect(await api.usage(me.id)).toMatchObject({ reservedBytes: 12 * MiB });
        expect(
          api.storage.calls.filter((c) => c.startsWith('create ') && c.includes(me.id)),
        ).toHaveLength(1);
      });

      it('answers IDEMPOTENCY_KEY_REUSED for another declaration', async () => {
        nextWindow();
        const me = await api.photographer({ quotaBytes: 100 * MiB });
        expect((await init(me, { clientUploadId })).status).toBe(201);
        for (const changed of [{ size: 13 * MiB }, { name: 'other.jpg' }, { relativePath: 'x' }]) {
          nextWindow();
          const res = await init(me, { clientUploadId, ...changed });
          expect(res.status, JSON.stringify(changed)).toBe(422);
          expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
        }
      });

      it('answers CONFLICT once completed or expired, and frees the id after an abort', async () => {
        nextWindow();
        const me = await api.photographer({ quotaBytes: 100 * MiB });
        const res = (await init(me, { clientUploadId })).body;
        expect((await complete(me, res.fileId, uploadParts(res, 12 * MiB))).status).toBe(200);
        expect(await init(me, { clientUploadId })).toMatchObject({
          status: 409,
          body: { code: 'CONFLICT' },
        });

        const other = '0b2f8a6e-4c1d-4e5f-8a9b-0c1d2e3f4a5b';
        const open = (await init(me, { clientUploadId: other, name: 'b.jpg' })).body;
        nextWindow();
        expect((await abort(me, open.fileId)).status).toBe(204);
        const fresh = await init(me, { clientUploadId: other, name: 'b.jpg' });
        expect(fresh.status).toBe(201);
        expect(fresh.body.fileId).not.toBe(open.fileId);

        api.clock.advance(25 * 3600 * 1000);
        expect(await init(me, { clientUploadId: other, name: 'b.jpg' })).toMatchObject({
          status: 409,
          body: { code: 'CONFLICT' },
        });
      });

      it('is scoped per photographer', async () => {
        nextWindow();
        const a = await api.photographer({ quotaBytes: 100 * MiB });
        const b = await api.photographer({ quotaBytes: 100 * MiB });
        const ra = await init(a, { clientUploadId });
        const rb = await init(b, { clientUploadId });
        expect([ra.status, rb.status]).toEqual([201, 201]);
        expect(ra.body.fileId).not.toBe(rb.body.fileId);
      });
    });
  });
}
