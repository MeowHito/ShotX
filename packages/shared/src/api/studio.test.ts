import { describe, expect, it } from 'vitest';
import { decodeDriveCursor, encodeDriveCursor } from '../drive/cursor';
import { driveSearchKey, driveSearchPattern } from '../drive/search';
import { ErrorCode } from '../errors';
import {
  isFileCopy,
  mediaOriginals,
  parseQueueMessage,
  parseZipEntries,
  queueJobName,
  QueueMessageError,
  serializeQueueMessage,
} from '../queues/index';
import { isSafeZipEntryPath, uniqueZipEntryPaths } from '../queues/zip';
import { derivedKey, originalKey } from '../s3-keys';
import { DRIVE_ROUTES } from './routes';
import {
  copyFileBodySchema,
  downloadFolderBodySchema,
  folderSummaryResponseSchema,
  getFileResponseSchema,
  listRecentQuerySchema,
  searchDriveQuerySchema,
  searchDriveResponseSchema,
  searchExcludesFolders,
} from './studio';

const id = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';
const other = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9d';
const photographerId = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';

describe('POST /drive/files/:id/copy', () => {
  it('copies into a folder or the root, renaming on conflict by default', () => {
    expect(copyFileBodySchema.parse({ targetFolderId: null })).toEqual({
      targetFolderId: null,
      onNameConflict: 'rename',
    });
    expect(
      copyFileBodySchema.parse({
        targetFolderId: id,
        name: '  ภาพวิ่ง.jpg ',
        onNameConflict: 'fail',
        clientCopyId: other,
      }),
    ).toEqual({
      targetFolderId: id,
      name: 'ภาพวิ่ง.jpg',
      onNameConflict: 'fail',
      clientCopyId: other,
    });
  });

  it.each([
    [{}],
    [{ targetFolderId: 'root' }],
    [{ targetFolderId: null, name: 'a/b.jpg' }],
    [{ targetFolderId: null, ownerId: id }],
  ])('rejects %j', (body) => {
    expect(copyFileBodySchema.safeParse(body).success).toBe(false);
  });

  it('is a photographer route with the quota, gate and name errors', () => {
    const route = DRIVE_ROUTES.copyFile;
    expect([route.method, route.path, route.status, route.auth]).toEqual([
      'POST',
      '/drive/files/:id/copy',
      201,
      'photographer',
    ]);
    for (const code of [
      ErrorCode.QUOTA_EXCEEDED,
      ErrorCode.SUBSCRIPTION_INACTIVE,
      ErrorCode.NAME_TAKEN,
      ErrorCode.NOT_FOUND,
      ErrorCode.CONFLICT,
      ErrorCode.RATE_LIMITED,
    ]) {
      expect(route.errors).toContain(code);
    }
  });
});

describe('the file.copy media message', () => {
  const message = { kind: 'file.copy', fileId: id, sourceFileId: other, photographerId } as const;

  it('round-trips, is named, and is never mistaken for an original', () => {
    const parsed = parseQueueMessage('media', serializeQueueMessage('media', message));
    expect(parsed).toEqual(message);
    expect(isFileCopy(parsed)).toBe(true);
    expect(queueJobName('media', parsed)).toBe('media.file-copy');
    expect(() => mediaOriginals(parsed, 'bucket')).toThrow(/handle it with isFileCopy/);
  });

  it('refuses a copy of itself and non-uuid ids', () => {
    for (const bad of [
      { ...message, sourceFileId: id },
      { ...message, fileId: 'x' },
      { ...message, photographerId: undefined },
    ]) {
      expect(() => parseQueueMessage('media', JSON.stringify(bad))).toThrow(QueueMessageError);
    }
  });
});

describe('owner folder zips', () => {
  it('downloads originals by default', () => {
    expect(downloadFolderBodySchema.parse({})).toEqual({ size: 'original' });
    expect(downloadFolderBodySchema.parse({ size: 'web' })).toEqual({ size: 'web' });
    expect(downloadFolderBodySchema.safeParse({ size: 'thumb' }).success).toBe(false);
    expect(DRIVE_ROUTES.downloadFolder.errors).toContain(ErrorCode.ZIP_TOO_LARGE);
    expect(DRIVE_ROUTES.ownerZipJob.path).toBe('/drive/zip-jobs/:id');
  });

  it('keeps the folder structure in safe, unique entry paths', () => {
    expect(
      uniqueZipEntryPaths([
        ['Day 1', 'IMG_0001.jpg'],
        ['Day 1', 'img_0001.JPG'],
        ['Day 2', 'IMG_0001.jpg'],
        ['ภาพ.jpg'],
      ]),
    ).toEqual(['Day 1/IMG_0001.jpg', 'Day 1/img_0001 (2).JPG', 'Day 2/IMG_0001.jpg', 'ภาพ.jpg']);
    expect(() => uniqueZipEntryPaths([['..', 'a.jpg']])).toThrow(RangeError);
    expect(() => uniqueZipEntryPaths([[]])).toThrow(RangeError);
    expect(() =>
      uniqueZipEntryPaths([
        ['a'.repeat(255), 'b'.repeat(255), 'c'.repeat(255), 'd'.repeat(255), 'e.jpg'],
      ]),
    ).toThrow(/too long/);
  });

  it('never gives a file the path of a directory, whatever the order, ignoring case', () => {
    // The file comes first, then a folder of the same name: the file is renamed.
    expect(uniqueZipEntryPaths([['IMG.jpg'], ['IMG.jpg', 'a.jpg']])).toEqual([
      'IMG (2).jpg',
      'IMG.jpg/a.jpg',
    ]);
    // The folder comes first, and the names differ only in case.
    expect(uniqueZipEntryPaths([['img.JPG', 'a.jpg'], ['IMG.jpg']])).toEqual([
      'img.JPG/a.jpg',
      'IMG (2).jpg',
    ]);
    // Deeper prefixes too, and a numbered name that is itself a directory is skipped.
    expect(
      uniqueZipEntryPaths([
        ['Day 1', 'Run'],
        ['Day 1', 'Run', 'a.jpg'],
        ['Day 1', 'Run (2)', 'b.jpg'],
      ]),
    ).toEqual(['Day 1/Run (3)', 'Day 1/Run/a.jpg', 'Day 1/Run (2)/b.jpg']);
    // Every output is a file path that no other output lives under.
    const out = uniqueZipEntryPaths([
      ['a', 'b.jpg'],
      ['a'],
      ['A', 'c.jpg'],
      ['a', 'b.jpg', 'd.jpg'],
    ]);
    const keys = out.map((p) => p.toLowerCase());
    for (const path of keys) {
      expect(
        keys.filter((other) => other.startsWith(`${path}/`)),
        path,
      ).toEqual([]);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('validates paths so extraction never leaves the target directory', () => {
    for (const ok of ['a.jpg', 'Day 1/a.jpg', 'a/b/c/ภาพ.jpg'])
      expect(isSafeZipEntryPath(ok), ok).toBe(true);
    for (const bad of [
      '',
      '/a.jpg',
      'a/',
      'a//b.jpg',
      '../a.jpg',
      'a/../b',
      './a',
      '.hidden/a.jpg',
      'a\\b.jpg',
    ]) {
      expect(isSafeZipEntryPath(bad), bad).toBe(false);
    }
    const key = originalKey({ photographerId, fileId: id, originalName: 'a.jpg' });
    expect(
      parseZipEntries({
        photographerId,
        entries: [{ fileId: id, key, name: 'Day 1/a.jpg', bytes: 1 }],
      }).entries[0]?.name,
    ).toBe('Day 1/a.jpg');
    expect(() =>
      parseZipEntries({
        photographerId,
        entries: [
          { fileId: id, key, name: 'Day 1/a.jpg', bytes: 1 },
          {
            fileId: other,
            key: derivedKey({ photographerId, fileId: other }, 'web'),
            name: 'day 1/A.JPG',
            bytes: 1,
          },
        ],
      }),
    ).toThrow(/unique/);
  });
});

describe('GET /drive/recent and GET /drive/search', () => {
  it('pages recent files', () => {
    expect(listRecentQuerySchema.parse({})).toEqual({});
    expect(listRecentQuerySchema.parse({ limit: '20' })).toEqual({ limit: 20 });
    expect(listRecentQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
  });

  it('needs a criterion and checks date ranges', () => {
    expect(searchDriveQuerySchema.safeParse({}).success).toBe(false);
    expect(searchDriveQuerySchema.safeParse({ includeTrashed: 'true' }).success).toBe(false);
    const parsed = searchDriveQuerySchema.parse({ q: '  งานวิ่ง ' });
    expect(parsed).toMatchObject({
      q: 'งานวิ่ง',
      type: 'any',
      includeTrashed: false,
      sort: 'name',
      order: 'asc',
    });
    expect(searchExcludesFolders(parsed)).toBe(false);
    const files = searchDriveQuerySchema.parse({
      type: 'video',
      takenFrom: '2026-10-01T00:00:00+07:00',
      takenTo: '2026-10-02T00:00:00+07:00',
      folderId: id,
      includeTrashed: 'true',
    });
    expect(files).toMatchObject({ type: 'video', folderId: id, includeTrashed: true });
    expect(searchExcludesFolders(files)).toBe(true);
    expect(searchExcludesFolders(searchDriveQuerySchema.parse({ folderId: id }))).toBe(false);
    for (const bad of [
      { q: '' },
      { q: '   ' },
      { q: 'x'.repeat(101) },
      { type: 'audio' },
      { takenFrom: '2026-10-02T00:00:00Z', takenTo: '2026-10-01T00:00:00Z' },
      { uploadedFrom: '2026-10-02T00:00:00Z', uploadedTo: '2026-10-02T00:00:00Z' },
      { takenFrom: 'yesterday' },
      { folderId: 'root' },
    ]) {
      expect(searchDriveQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('builds the LIKE pattern: contains, ASCII case folded, wildcards escaped', () => {
    expect(driveSearchKey('  IMG_00 ')).toBe('img_00');
    expect(driveSearchKey('Äpfel')).toBe('Äpfel');
    expect(driveSearchPattern('IMG_0%')).toBe('%img\\_0\\%%');
    expect(driveSearchPattern('a\\b')).toBe('%a\\\\b%');
    expect(driveSearchPattern('งานวิ่ง')).toBe('%งานวิ่ง%');
    // NFC, as stored names are: a decomposed é matches the composed one.
    expect(driveSearchKey('Café')).toBe('café');
  });

  it('returns items with their location and says when the cap was hit', () => {
    const folder = {
      kind: 'folder',
      id,
      parentId: null,
      name: 'งานวิ่ง',
      createdAt: '2026-10-28T00:00:00Z',
      deletedAt: null,
      faceIndexEnabled: false,
      faceIndexExpiresAt: null,
      coverFileId: null,
    };
    const response = {
      items: [{ item: folder, ancestors: [] }],
      nextCursor: null,
      truncated: true,
    };
    expect(searchDriveResponseSchema.parse(response)).toEqual(response);
    expect(DRIVE_ROUTES.search.errors).toContain(ErrorCode.NOT_FOUND);
  });

  it('has cursors for the new listings, with a count for the search cap', () => {
    const cursor = {
      v: 1,
      sort: 'name',
      order: 'asc',
      phase: 'search_files',
      key: 'img_0001.jpg',
      kind: 'file',
      id,
      seen: 50,
    } as const;
    expect(decodeDriveCursor(encodeDriveCursor(cursor))).toEqual(cursor);
    const recent = {
      ...cursor,
      sort: 'createdAt',
      order: 'desc',
      phase: 'recent',
      key: null,
    } as const;
    const { seen: _seen, ...withoutSeen } = recent;
    void _seen;
    expect(decodeDriveCursor(encodeDriveCursor(withoutSeen))).toEqual(withoutSeen);
  });
});

describe('item info', () => {
  it('describes a file with its location, and a folder with its subtree', () => {
    const file = {
      kind: 'file',
      id,
      folderId: other,
      name: 'a.jpg',
      mime: 'image/jpeg',
      mediaKind: 'image',
      sizeBytes: 10,
      status: 'ready',
      width: 100,
      height: 50,
      takenAt: null,
      faceCount: null,
      createdAt: '2026-10-28T00:00:00Z',
      deletedAt: null,
    };
    expect(
      getFileResponseSchema.parse({ file, ancestors: [{ id: other, name: 'งานวิ่ง' }] }),
    ).toMatchObject({ ancestors: [{ name: 'งานวิ่ง' }] });
    const summary = {
      folder: {
        kind: 'folder',
        id: other,
        parentId: null,
        name: 'งานวิ่ง',
        createdAt: '2026-10-28T00:00:00Z',
        deletedAt: null,
        faceIndexEnabled: true,
        faceIndexExpiresAt: '2027-01-28T00:00:00Z',
        coverFileId: null,
      },
      ancestors: [],
      fileCount: 3,
      imageCount: 2,
      videoCount: 1,
      folderCount: 1,
      totalBytes: 123,
    };
    expect(folderSummaryResponseSchema.parse(summary)).toEqual(summary);
    expect(folderSummaryResponseSchema.safeParse({ ...summary, fileCount: -1 }).success).toBe(
      false,
    );
    expect(DRIVE_ROUTES.getFile.path).toBe('/drive/files/:id');
    expect(DRIVE_ROUTES.folderSummary.path).toBe('/drive/folders/:id/summary');
  });
});
