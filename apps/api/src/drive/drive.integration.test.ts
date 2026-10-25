import { randomUUID } from 'node:crypto';
import { files, folders } from '@shotx/db';
import {
  apiPath,
  DRIVE_ROUTES,
  type DriveFile,
  type DriveFolder,
  type DriveUsageResponse,
  type EmptyTrashResponse,
  type ListChildrenResponse,
  type ListTrashResponse,
  type RestoreItemsResponse,
  type TrashItemsResponse,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';
import { insertReadyFile } from '../testing/seed';

const R = DRIVE_ROUTES;

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`drive on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      // DRIVE_PAGE_SIZE=3 and DRIVE_MAX_FOLDER_DEPTH=4 (testEnv).
      api = await TestApi.start(database.db);
    });

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    type Me = Awaited<ReturnType<TestApi['photographer']>>;

    const mkdir = async (me: Me, name: string, parentId: string | null = null) => {
      const res = await api.request<DriveFolder>('POST', apiPath(R.createFolder), {
        token: me.token,
        body: { parentId, name },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    };
    const children = (me: Me, id: string, query = '') =>
      api.request<ListChildrenResponse>('GET', `${apiPath(R.listChildren, { id })}${query}`, {
        token: me.token,
      });
    const patchFolder = (me: Me, id: string, body: unknown) =>
      api.request<DriveFolder>('PATCH', apiPath(R.updateFolder, { id }), { token: me.token, body });
    const patchFile = (me: Me, id: string, body: unknown) =>
      api.request<DriveFile>('PATCH', apiPath(R.updateFile, { id }), { token: me.token, body });
    const trash = (me: Me, items: { kind: 'folder' | 'file'; id: string }[]) =>
      api.request<TrashItemsResponse>('POST', apiPath(R.trashItems), {
        token: me.token,
        body: { items },
      });
    const restore = (me: Me, items: { kind: 'folder' | 'file'; id: string }[]) =>
      api.request<RestoreItemsResponse>('POST', apiPath(R.restoreItems), {
        token: me.token,
        body: { items },
      });
    const folderRow = async (id: string) =>
      (await api.db.select().from(folders).where(eq(folders.id, id)))[0];
    const fileRow = async (id: string) =>
      (await api.db.select().from(files).where(eq(files.id, id)))[0];

    describe('folders', () => {
      it('creates folders at the root and inside a folder, with ltree paths of ids', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, '  งานวิ่ง 2026  ');
        expect(a).toMatchObject({
          kind: 'folder',
          parentId: null,
          name: 'งานวิ่ง 2026',
          deletedAt: null,
        });
        const b = await mkdir(me, 'Day 1', a.id);
        expect((await folderRow(b.id))?.path).toBe(`${a.id}.${b.id}`.replace(/-/g, '_'));
      });

      it('answers NAME_TAKEN for a sibling name that differs only in ASCII case', async () => {
        const me = await api.photographer();
        await mkdir(me, 'Event');
        const res = await api.request('POST', apiPath(R.createFolder), {
          token: me.token,
          body: { parentId: null, name: 'EVENT' },
        });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'NAME_TAKEN',
          details: { kind: 'folder', name: 'EVENT' },
        });
        // Folders and files are separate namespaces.
        await insertReadyFile(api.db, me.id, { name: 'Event2.jpg' });
        await mkdir(me, 'Event2.jpg');
      });

      it('enforces DRIVE_MAX_FOLDER_DEPTH', async () => {
        const me = await api.photographer();
        let parent: string | null = null;
        for (let i = 1; i <= 4; i++) parent = (await mkdir(me, `L${i}`, parent)).id;
        const res = await api.request('POST', apiPath(R.createFolder), {
          token: me.token,
          body: { parentId: parent, name: 'L5' },
        });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'FOLDER_DEPTH_EXCEEDED', details: { maxDepth: 4 } });
      });
    });

    describe('ownership', () => {
      it("returns NOT_FOUND for another photographer's folders and files", async () => {
        const owner = await api.photographer();
        const other = await api.photographer();
        const folder = await mkdir(owner, 'Private');
        const file = await insertReadyFile(api.db, owner.id, { name: 'a.jpg' });
        const attempts = [
          await children(other, folder.id),
          await api.request('POST', apiPath(R.createFolder), {
            token: other.token,
            body: { parentId: folder.id, name: 'x' },
          }),
          await patchFolder(other, folder.id, { name: 'stolen' }),
          await patchFile(other, file.id, { name: 'stolen.jpg' }),
          await patchFile(other, file.id, { folderId: null }),
          await trash(other, [{ kind: 'folder', id: folder.id }]),
          await trash(other, [{ kind: 'file', id: file.id }]),
          await restore(other, [{ kind: 'file', id: file.id }]),
        ];
        for (const res of attempts) {
          expect(res.status).toBe(404);
          expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
        }
        // Moving one's own folder into someone else's folder is NOT_FOUND too.
        const mine = await mkdir(other, 'Mine');
        expect((await patchFolder(other, mine.id, { parentId: folder.id })).status).toBe(404);
        expect((await folderRow(folder.id))?.name).toBe('Private');
        expect((await fileRow(file.id))?.deletedAt).toBeNull();
        // The root listing only shows the caller's items.
        const root = await children(other, 'root');
        expect(root.body.items.map((i) => i.id)).toEqual([mine.id]);
      });
    });

    describe('children listing', () => {
      it('pages folders first, then files, with keyset cursors', async () => {
        const me = await api.photographer();
        const parent = await mkdir(me, 'Album');
        const names = ['b', 'A', 'c'];
        for (const n of names) await mkdir(me, n, parent.id);
        for (const n of ['z.jpg', 'B.jpg', 'a.jpg']) {
          await insertReadyFile(api.db, me.id, { name: n, folderId: parent.id });
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const query: string = cursor === null ? '' : `?cursor=${cursor}`;
          const res = await children(me, parent.id, query);
          expect(res.status).toBe(200);
          expect(res.body.folder?.id).toBe(parent.id);
          seen.push(...res.body.items.map((i) => `${i.kind}:${i.name}`));
          cursor = res.body.nextCursor;
          pages++;
        } while (cursor !== null);
        expect(pages).toBe(2);
        expect(seen).toEqual([
          'folder:A',
          'folder:b',
          'folder:c',
          'file:a.jpg',
          'file:B.jpg',
          'file:z.jpg',
        ]);

        const desc = await children(me, parent.id, '?sort=name&order=desc&limit=4');
        expect(desc.body.items.map((i) => i.name)).toEqual(['c', 'b', 'A', 'z.jpg']);
        const next = await children(
          me,
          parent.id,
          `?sort=name&order=desc&limit=4&cursor=${desc.body.nextCursor}`,
        );
        expect(next.body.items.map((i) => i.name)).toEqual(['B.jpg', 'a.jpg']);
        expect(next.body.nextCursor).toBeNull();

        const byCreation = await children(me, parent.id, '?sort=createdAt&limit=10');
        expect(byCreation.body.items.map((i) => i.name)).toEqual([
          'b',
          'A',
          'c',
          'z.jpg',
          'B.jpg',
          'a.jpg',
        ]);
      });

      it('rejects cursors of another sort or malformed ones', async () => {
        const me = await api.photographer();
        for (const n of ['1', '2', '3', '4']) await mkdir(me, n);
        const page = await children(me, 'root');
        const cursor = page.body.nextCursor;
        expect(cursor).not.toBeNull();
        for (const query of [
          `?cursor=${cursor}&order=desc`,
          `?cursor=${cursor}&sort=createdAt`,
          '?cursor=abc',
        ]) {
          const res = await children(me, 'root', query);
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
        }
        expect((await children(me, 'ROOT')).status).toBe(400);
      });

      it('returns breadcrumbs and signed CloudFront URLs, never S3 URLs', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, 'A');
        const b = await mkdir(me, 'B', a.id);
        const c = await mkdir(me, 'C', b.id);
        await insertReadyFile(api.db, me.id, { name: 'p.jpg', folderId: c.id });
        const res = await children(me, c.id);
        expect(res.body.ancestors).toEqual([
          { id: a.id, name: 'A' },
          { id: b.id, name: 'B' },
        ]);
        const [file] = res.body.items as DriveFile[];
        expect(file?.thumbUrl).toMatch(
          /^https:\/\/photos\.example\.com\/media\/derived\/.+\/thumb\.webp\?Expires=\d+&Key-Pair-Id=K2JCJMDEHXQW5F&Signature=/,
        );
        expect(file?.previewUrl).toContain('/media/derived/');
        expect(JSON.stringify(res.body)).not.toMatch(/amazonaws\.com|s3:\/\//);
      });
    });

    describe('rename and move', () => {
      it('moves a subtree in one transaction, rewriting every descendant path', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, 'A');
        const b = await mkdir(me, 'B', a.id);
        const c = await mkdir(me, 'C', b.id);
        const target = await mkdir(me, 'Target');
        const res = await patchFolder(me, b.id, { parentId: target.id });
        expect(res.status).toBe(200);
        expect(res.body.parentId).toBe(target.id);
        const label = (id: string) => id.replace(/-/g, '_');
        expect((await folderRow(b.id))?.path).toBe(`${label(target.id)}.${label(b.id)}`);
        expect((await folderRow(c.id))?.path).toBe(
          `${label(target.id)}.${label(b.id)}.${label(c.id)}`,
        );
        // And back to the root.
        await patchFolder(me, b.id, { parentId: null });
        expect((await folderRow(c.id))?.path).toBe(`${label(b.id)}.${label(c.id)}`);
      });

      it('rejects moving a folder into itself or its own descendant', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, 'A');
        const b = await mkdir(me, 'B', a.id);
        const c = await mkdir(me, 'C', b.id);
        for (const parentId of [a.id, b.id, c.id]) {
          const res = await patchFolder(me, a.id, { parentId });
          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ code: 'INVALID_MOVE' });
        }
        expect((await folderRow(a.id))?.parentId).toBeNull();
      });

      it('rejects moves that make the tree too deep', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, 'A');
        const b = await mkdir(me, 'B', a.id);
        const x = await mkdir(me, 'X');
        const y = await mkdir(me, 'Y', x.id);
        const z = await mkdir(me, 'Z', y.id);
        const res = await patchFolder(me, a.id, { parentId: z.id });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'FOLDER_DEPTH_EXCEEDED' });
        void b;
      });

      it('renames, and answers NAME_TAKEN at the destination; rename+move checks the final name', async () => {
        const me = await api.photographer();
        const dest = await mkdir(me, 'Dest');
        await mkdir(me, 'Photos', dest.id);
        const photos = await mkdir(me, 'photos');
        const clash = await patchFolder(me, photos.id, { parentId: dest.id });
        expect(clash.status).toBe(409);
        expect(clash.body).toMatchObject({ code: 'NAME_TAKEN' });
        const both = await patchFolder(me, photos.id, { parentId: dest.id, name: 'Photos 2' });
        expect(both.status).toBe(200);
        expect(both.body).toMatchObject({ name: 'Photos 2', parentId: dest.id });
        const renamed = await patchFolder(me, photos.id, { name: 'PHOTOS 2' });
        expect(renamed.body.name).toBe('PHOTOS 2');
      });

      it('renames and moves files, keeping their type', async () => {
        const me = await api.photographer();
        const folder = await mkdir(me, 'F');
        const file = await insertReadyFile(api.db, me.id, { name: 'a.jpg' });
        await insertReadyFile(api.db, me.id, { name: 'taken.jpg', folderId: folder.id });
        const ok = await patchFile(me, file.id, { name: 'b.JPEG' });
        expect(ok).toMatchObject({ status: 200, body: { name: 'b.JPEG', folderId: null } });
        const wrongType = await patchFile(me, file.id, { name: 'b.png' });
        expect(wrongType.status).toBe(415);
        expect(wrongType.body).toMatchObject({
          code: 'UNSUPPORTED_FILE_TYPE',
          details: { extension: 'png' },
        });
        const moved = await patchFile(me, file.id, { folderId: folder.id });
        expect(moved.body.folderId).toBe(folder.id);
        const clash = await patchFile(me, file.id, { name: 'TAKEN.jpg' });
        expect(clash.status).toBe(409);
        expect(clash.body).toMatchObject({
          code: 'NAME_TAKEN',
          details: { kind: 'file', name: 'TAKEN.jpg' },
        });
      });
    });

    describe('trash and restore', () => {
      it('trashes a nested folder with its subtree and restores it whole', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, 'A');
        const b = await mkdir(me, 'B', a.id);
        const f1 = await insertReadyFile(api.db, me.id, { name: '1.jpg', folderId: a.id });
        const f2 = await insertReadyFile(api.db, me.id, { name: '2.jpg', folderId: b.id });
        const res = await trash(me, [{ kind: 'folder', id: a.id }]);
        expect(res.status).toBe(200);
        const deletedAt = res.body.items[0]?.deletedAt;
        for (const row of [await folderRow(b.id), await fileRow(f1.id), await fileRow(f2.id)]) {
          expect(row?.deletedAt?.toISOString()).toBe(deletedAt);
          expect(row?.trashedViaFolderId).toBe(a.id);
        }
        expect((await folderRow(a.id))?.trashedViaFolderId).toBeNull();

        // Only what the user trashed is listed, and inner items can't be restored alone.
        const listed = await api.request<ListTrashResponse>('GET', apiPath(R.listTrash), {
          token: me.token,
        });
        expect(listed.body.items.map((i) => i.id)).toEqual([a.id]);
        expect(listed.body.items[0]?.purgeAt).toBe(
          new Date(Date.parse(deletedAt ?? '') + 30 * 86_400_000).toISOString(),
        );
        expect((await restore(me, [{ kind: 'folder', id: b.id }])).status).toBe(404);
        expect((await children(me, a.id)).status).toBe(404);

        // Trashing again leaves it as it was.
        const again = await trash(me, [{ kind: 'folder', id: a.id }]);
        expect(again.body.items[0]?.deletedAt).toBe(deletedAt);

        const restored = await restore(me, [{ kind: 'folder', id: a.id }]);
        expect(restored.status).toBe(200);
        expect(restored.body.items[0]).toMatchObject({ id: a.id, name: 'A', deletedAt: null });
        for (const row of [await folderRow(b.id), await fileRow(f1.id), await fileRow(f2.id)]) {
          expect(row?.deletedAt).toBeNull();
          expect(row?.trashedViaFolderId).toBeNull();
        }
      });

      it('restores to the root when the old parent is gone, renaming to " (2)" on conflict', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, 'A');
        const b = await mkdir(me, 'B', a.id);
        const file = await insertReadyFile(api.db, me.id, { name: 'x.jpg', folderId: a.id });
        await trash(me, [{ kind: 'folder', id: b.id }]);
        await trash(me, [{ kind: 'file', id: file.id }]);
        await trash(me, [{ kind: 'folder', id: a.id }]);
        await mkdir(me, 'b'); // takes B's name at the root (ASCII case-insensitive)
        await insertReadyFile(api.db, me.id, { name: 'X.jpg' });

        const res = await restore(me, [
          { kind: 'folder', id: b.id },
          { kind: 'file', id: file.id },
        ]);
        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([
          expect.objectContaining({ kind: 'folder', id: b.id, parentId: null, name: 'B (2)' }),
          expect.objectContaining({ kind: 'file', id: file.id, folderId: null, name: 'x (2).jpg' }),
        ]);
        expect((await folderRow(b.id))?.path).toBe(b.id.replace(/-/g, '_'));
        // A is still in the trash.
        expect((await folderRow(a.id))?.deletedAt).not.toBeNull();
      });

      it('rejects a batch with any unknown id without changing anything', async () => {
        const me = await api.photographer();
        const a = await mkdir(me, 'A');
        const res = await trash(me, [
          { kind: 'folder', id: a.id },
          { kind: 'file', id: randomUUID() },
        ]);
        expect(res.status).toBe(404);
        expect((await folderRow(a.id))?.deletedAt).toBeNull();
      });

      it('lists the trash newest first with cursors', async () => {
        const me = await api.photographer();
        const ids: string[] = [];
        for (const n of ['1', '2', '3', '4']) {
          const f = await mkdir(me, n);
          await trash(me, [{ kind: 'folder', id: f.id }]);
          ids.unshift(f.id);
        }
        const file = await insertReadyFile(api.db, me.id, { name: 'f.jpg' });
        await trash(me, [{ kind: 'file', id: file.id }]);
        ids.unshift(file.id);
        const first = await api.request<ListTrashResponse>('GET', apiPath(R.listTrash), {
          token: me.token,
        });
        const second = await api.request<ListTrashResponse>(
          'GET',
          `${apiPath(R.listTrash)}?cursor=${first.body.nextCursor}`,
          { token: me.token },
        );
        expect([...first.body.items, ...second.body.items].map((i) => i.id)).toEqual(ids);
        expect(second.body.nextCursor).toBeNull();
      });
    });

    describe('empty trash and usage', () => {
      it('marks the trash for purge and releases its bytes in the same transaction', async () => {
        const me = await api.photographer({ quotaBytes: 10_000 });
        const a = await mkdir(me, 'A');
        await insertReadyFile(api.db, me.id, { name: '1.jpg', folderId: a.id, sizeBytes: 1000 });
        const loose = await insertReadyFile(api.db, me.id, { name: '2.jpg', sizeBytes: 500 });
        await insertReadyFile(api.db, me.id, { name: 'kept.jpg', sizeBytes: 300 });
        await trash(me, [
          { kind: 'folder', id: a.id },
          { kind: 'file', id: loose.id },
        ]);

        const before = await api.request<DriveUsageResponse>('GET', apiPath(R.usage), {
          token: me.token,
        });
        expect(before.body).toMatchObject({
          usedBytes: 1800,
          reservedBytes: 0,
          quotaBytes: 10_000,
          availableBytes: 8200,
          trashBytes: 1500,
          uploadsBlockedBy: null,
          subscription: { status: 'active' },
        });

        const res = await api.request<EmptyTrashResponse>('DELETE', apiPath(R.emptyTrash), {
          token: me.token,
        });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ folders: 1, files: 2, bytes: 1500 });
        expect((await folderRow(a.id))?.purgeRequestedAt).not.toBeNull();
        expect(await api.usage(me.id)).toMatchObject({ usedBytes: 300, reservedBytes: 0 });
        const listed = await api.request<ListTrashResponse>('GET', apiPath(R.listTrash), {
          token: me.token,
        });
        expect(listed.body.items).toEqual([]);
        // Purge-requested items can't be restored or trashed again.
        expect((await restore(me, [{ kind: 'folder', id: a.id }])).status).toBe(404);
        // Emptying again releases nothing more.
        const again = await api.request<EmptyTrashResponse>('DELETE', apiPath(R.emptyTrash), {
          token: me.token,
        });
        expect(again.body).toEqual({ folders: 0, files: 0, bytes: 0 });
      });

      it('reports uploads blocked by the subscription or a full quota', async () => {
        const grace = await api.photographer({ status: 'grace' });
        const res = await api.request<DriveUsageResponse>('GET', apiPath(R.usage), {
          token: grace.token,
        });
        expect(res.body.uploadsBlockedBy).toBe('SUBSCRIPTION_INACTIVE');
        const full = await api.photographer({ quotaBytes: 1000 });
        await insertReadyFile(api.db, full.id, { name: 'a.jpg', sizeBytes: 1000 });
        const res2 = await api.request<DriveUsageResponse>('GET', apiPath(R.usage), {
          token: full.token,
        });
        expect(res2.body).toMatchObject({ uploadsBlockedBy: 'QUOTA_EXCEEDED', availableBytes: 0 });
      });
    });
  });
}
