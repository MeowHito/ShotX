import { ErrorCode } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { FolderSyncEngine, type SyncUploadOutcome } from './engine';
import type { SyncDirectoryHandle, SyncFileHandle, SyncPermissionState } from './fs-access';
import { isSyncableName } from './scan';
import { memorySyncStore, type SyncJob, type SyncStore } from './store';

interface FakeFile {
  size: number;
  lastModified: number;
}

/** A folder tree in memory with the File System Access shape; paths like `a/b.jpg`. */
function fakeFolder(name: string, permission: SyncPermissionState = 'granted') {
  const files = new Map<string, FakeFile>();
  let missing = false;
  const state = { permission, requested: 0 };

  function dir(prefix: string, dirName: string): SyncDirectoryHandle {
    return {
      kind: 'directory',
      name: dirName,
      async *values() {
        await Promise.resolve();
        if (missing) throw new DOMException('gone', 'NotFoundError');
        const seen = new Set<string>();
        for (const [path, file] of files) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const [head, ...tail] = rest.split('/');
          if (head === undefined || seen.has(head)) continue;
          seen.add(head);
          if (tail.length > 0) yield dir(`${prefix}${head}/`, head);
          else yield fileHandle(path, head, file);
        }
      },
      queryPermission: () => Promise.resolve(state.permission),
      requestPermission: () => {
        state.requested += 1;
        state.permission = 'granted';
        return Promise.resolve(state.permission);
      },
    };
  }

  function fileHandle(path: string, fileName: string, _initial: FakeFile): SyncFileHandle {
    return {
      kind: 'file',
      name: fileName,
      getFile: () => {
        const now = files.get(path);
        if (now === undefined) return Promise.reject(new DOMException('gone', 'NotFoundError'));
        return Promise.resolve(
          new File([new Uint8Array(now.size)], fileName, { lastModified: now.lastModified }),
        );
      },
    };
  }

  return {
    handle: dir('', name),
    state,
    put(path: string, size: number, lastModified = 1000) {
      files.set(path, { size, lastModified });
    },
    remove(path: string) {
      files.delete(path);
    },
    vanish() {
      missing = true;
    },
  };
}

interface Queued {
  file: File;
  relativePath: string | null;
  dest: string | null;
  key: string;
}

/** The upload queue: records what was added; tests end uploads with finish(). */
function fakeUploads(options: { reject?: (name: string) => boolean } = {}) {
  let listener: ((id: string, outcome: SyncUploadOutcome) => void) | null = null;
  const queued = new Map<string, Queued>();
  const removed: string[] = [];
  let n = 0;
  return {
    queued,
    removed,
    uploads: {
      add(file: File, relativePath: string | null, dest: string | null, key: string) {
        if (options.reject?.(file.name)) return { status: 'rejected' as const };
        n += 1;
        const id = `u${n}`;
        queued.set(id, { file, relativePath, dest, key });
        return { status: 'queued' as const, id };
      },
      watch(l: (id: string, outcome: SyncUploadOutcome) => void) {
        listener = l;
        return () => {
          listener = null;
        };
      },
      remove(id: string) {
        removed.push(id);
        queued.delete(id);
      },
    },
    /** Ends the upload of the queued file named `name`. */
    finish(name: string, outcome: SyncUploadOutcome = { ok: true }) {
      const entry = [...queued].find(([, q]) => q.file.name === name);
      if (entry === undefined) throw new Error(`${name} not queued`);
      listener?.(entry[0], outcome);
    },
    names: () => [...queued.values()].map((q) => q.file.name),
    keyOf(name: string): string | undefined {
      for (const q of queued.values()) if (q.file.name === name) return q.key;
      return undefined;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const apiError = (code: ErrorCode) => new ApiError(409, code, code, undefined);

function makeEngine(
  options: {
    store?: SyncStore;
    uploads?: ReturnType<typeof fakeUploads>;
    lockFree?: boolean;
    owner?: string;
    supported?: boolean;
    maxQueued?: number;
    retryDelaysMs?: number[];
    settleMs?: number;
  } = {},
) {
  const clock = { now: 10_000 };
  let ids = 0;
  const uploads = options.uploads ?? fakeUploads();
  const store = options.store ?? memorySyncStore();
  const engine = new FolderSyncEngine({
    store,
    uploads: uploads.uploads,
    lock: {
      acquire: () => Promise.resolve(options.lockFree ?? true),
      release: () => undefined,
    },
    owner: options.owner ?? 'owner-1',
    supported: options.supported ?? true,
    config: {
      intervalMs: 5000,
      settleMs: options.settleMs ?? 0,
      maxQueued: options.maxQueued ?? 20,
      maxDepth: 3,
      retryDelaysMs: options.retryDelaysMs ?? [1000, 5000],
      recentMax: 10,
    },
    now: () => clock.now,
    // Scans run when the test calls tick().
    setTimer: () => 1,
    clearTimer: () => undefined,
    newId: () => `id-${++ids}`,
  });
  return { engine, uploads, store, clock };
}

async function setUp(
  engine: FolderSyncEngine,
  folder: ReturnType<typeof fakeFolder>,
  options: { includeExisting?: boolean; includeSubfolders?: boolean } = {},
) {
  await engine.init();
  await engine.setup({
    handle: folder.handle,
    destination: { id: 'dest-1', name: 'Event' },
    includeSubfolders: options.includeSubfolders ?? true,
    includeExisting: options.includeExisting ?? true,
  });
}

describe('FolderSyncEngine', () => {
  it('says so in browsers without the folder picker', async () => {
    const { engine } = makeEngine({ supported: false });
    await engine.init();
    expect(engine.getSnapshot().status).toBe('unsupported');
  });

  it('is idle until a folder is set up', async () => {
    const { engine } = makeEngine();
    await engine.init();
    expect(engine.getSnapshot().status).toBe('idle');
  });

  it('uploads a file once two scans saw it unchanged, oldest first, into the destination', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_2.jpg', 20, 2000);
    folder.put('IMG_1.jpg', 10, 1000);
    const { engine, uploads } = makeEngine();
    await setUp(engine, folder);
    // The first scan only records what is there.
    expect(uploads.names()).toEqual([]);
    expect(engine.getSnapshot().status).toBe('running');

    await engine.tick();
    expect(uploads.names()).toEqual(['IMG_1.jpg', 'IMG_2.jpg']);
    expect([...uploads.queued.values()].every((q) => q.dest === 'dest-1')).toBe(true);
    expect(engine.getSnapshot().stats.uploading).toBe(2);

    uploads.finish('IMG_1.jpg');
    uploads.finish('IMG_2.jpg');
    await flush();
    const snap = engine.getSnapshot();
    expect(snap.stats.uploaded).toBe(2);
    expect(snap.stats.uploading).toBe(0);
    expect(snap.recent.map((r) => r.outcome)).toEqual(['uploaded', 'uploaded']);
    // Finished uploads leave the studio queue.
    expect(uploads.removed).toHaveLength(2);

    await engine.tick();
    expect(uploads.names()).toEqual([]);
  });

  it('waits while the exporting app is still writing a file', async () => {
    const folder = fakeFolder('Export');
    const { engine, uploads } = makeEngine();
    await setUp(engine, folder);
    folder.put('IMG_1.jpg', 10, 1000);
    await engine.tick(); // first seen
    folder.put('IMG_1.jpg', 50, 1001); // still growing
    await engine.tick();
    expect(uploads.names()).toEqual([]);
    expect(engine.getSnapshot().stats.waiting).toBe(1);
    await engine.tick(); // unchanged since the previous scan
    expect(uploads.names()).toEqual(['IMG_1.jpg']);
  });

  it('waits settleMs after the last write, so a watermark plugin’s rewrite is what uploads', async () => {
    const folder = fakeFolder('Export');
    const { engine, uploads, clock } = makeEngine({ settleMs: 20_000 });
    await setUp(engine, folder);
    // Lightroom writes the export…
    folder.put('IMG_1.jpg', 10, clock.now);
    await engine.tick();
    clock.now += 5000;
    await engine.tick(); // unchanged for one scan, but written only 5 s ago
    expect(uploads.names()).toEqual([]);
    // …and the watermark plugin rewrites it a few seconds later.
    folder.put('IMG_1.jpg', 12, clock.now);
    await engine.tick();
    clock.now += 19_000;
    await engine.tick();
    expect(uploads.names()).toEqual([]);
    clock.now += 1000;
    await engine.tick(); // untouched for 20 s: the watermarked version goes up
    expect([...uploads.queued.values()].map((q) => q.file.size)).toEqual([12]);
  });

  it('keeps subfolders as the relative path, and skips them when asked', async () => {
    const folder = fakeFolder('Export');
    folder.put('Day 1/A.jpg', 10);
    folder.put('B.jpg', 10);
    const { engine, uploads } = makeEngine();
    await setUp(engine, folder);
    await engine.tick();
    expect([...uploads.queued.values()].map((q) => [q.file.name, q.relativePath])).toEqual([
      ['B.jpg', null],
      ['A.jpg', 'Day 1'],
    ]);

    const flat = makeEngine();
    await setUp(flat.engine, folder, { includeSubfolders: false });
    await flat.engine.tick();
    expect(flat.uploads.names()).toEqual(['B.jpg']);
  });

  it('records a name already in the drive folder as exists and never tries it again', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads } = makeEngine();
    await setUp(engine, folder);
    await engine.tick();
    uploads.finish('IMG_1.jpg', { ok: false, error: apiError(ErrorCode.NAME_TAKEN) });
    await flush();
    expect(engine.getSnapshot().stats.exists).toBe(1);
    await engine.tick();
    await engine.tick();
    expect(uploads.names()).toEqual([]);
  });

  it('"only new files" leaves what was there at set-up alone', async () => {
    const folder = fakeFolder('Export');
    folder.put('old.jpg', 10);
    const { engine, uploads } = makeEngine();
    await setUp(engine, folder, { includeExisting: false });
    folder.put('new.jpg', 10, 5000);
    await engine.tick();
    await engine.tick();
    expect(uploads.names()).toEqual(['new.jpg']);
  });

  it('counts other file types as ignored and refused files as skipped once', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    folder.put('IMG_1.xmp', 10);
    folder.put('.DS_Store', 10);
    folder.put('huge.jpg', 10);
    const uploads = fakeUploads({ reject: (name) => name === 'huge.jpg' });
    const { engine } = makeEngine({ uploads });
    await setUp(engine, folder);
    await engine.tick();
    await engine.tick();
    const snap = engine.getSnapshot();
    expect(snap.stats.ignored).toBe(1);
    expect(snap.stats.skipped).toBe(1);
    expect(uploads.names()).toEqual(['IMG_1.jpg']);
  });

  it('keeps at most maxQueued files in the queue', async () => {
    const folder = fakeFolder('Export');
    for (let i = 0; i < 5; i++) folder.put(`IMG_${i}.jpg`, 10, 1000 + i);
    const { engine, uploads } = makeEngine({ maxQueued: 2 });
    await setUp(engine, folder);
    await engine.tick();
    expect(uploads.names()).toEqual(['IMG_0.jpg', 'IMG_1.jpg']);
    expect(engine.getSnapshot().stats.waiting).toBe(3);
    uploads.finish('IMG_0.jpg');
    await flush();
    await engine.tick();
    expect(uploads.names()).toEqual(['IMG_1.jpg', 'IMG_2.jpg']);
  });

  it('ADR 0021: uploads what the prepare step returns (the watermarked photo)', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads } = makeEngine();
    const seen: string[] = [];
    engine.setPrepare((file) => {
      seen.push(file.name);
      return Promise.resolve(new File(['watermarked!'], file.name, { type: 'image/jpeg' }));
    });
    await setUp(engine, folder);
    await engine.tick();
    expect(seen).toEqual(['IMG_1.jpg']);
    const [queued] = [...uploads.queued.values()];
    expect(queued?.file.name).toBe('IMG_1.jpg');
    expect(await queued?.file.text()).toBe('watermarked!');
    // Turned off: the file itself goes up.
    engine.setPrepare(null);
    folder.put('IMG_2.jpg', 10);
    await engine.tick();
    await engine.tick();
    expect([...uploads.queued.values()].find((q) => q.file.name === 'IMG_2.jpg')?.file.size).toBe(
      10,
    );
  });

  it('ADR 0021: a failing prepare step never sends the photo without its watermark; it retries', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads, clock } = makeEngine({ retryDelaysMs: [1000] });
    let fail = true;
    engine.setPrepare((file) =>
      fail ? Promise.reject(new Error('decode failed')) : Promise.resolve(file),
    );
    await setUp(engine, folder);
    await engine.tick();
    expect(uploads.names()).toEqual([]);
    await engine.tick(); // still inside the retry wait
    expect(uploads.names()).toEqual([]);
    fail = false;
    clock.now += 1000;
    await engine.tick();
    expect(uploads.names()).toEqual(['IMG_1.jpg']);
  });

  it('retries a failed upload after the configured waits, then counts it as failed', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads, clock } = makeEngine({ retryDelaysMs: [1000] });
    await setUp(engine, folder);
    await engine.tick();
    uploads.finish('IMG_1.jpg', { ok: false, error: new Error('network') });
    await flush();
    await engine.tick();
    expect(uploads.names()).toEqual([]); // waiting for the retry
    clock.now += 1000;
    await engine.tick();
    expect(uploads.names()).toEqual(['IMG_1.jpg']);
    uploads.finish('IMG_1.jpg', { ok: false, error: new Error('network') });
    await flush();
    expect(engine.getSnapshot().stats.failed).toBe(1);
    clock.now += 60_000;
    await engine.tick();
    expect(uploads.names()).toEqual([]);
  });

  it('stops when the drive folder is gone', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads } = makeEngine();
    await setUp(engine, folder);
    await engine.tick();
    uploads.finish('IMG_1.jpg', { ok: false, error: apiError(ErrorCode.NOT_FOUND) });
    await flush();
    expect(engine.getSnapshot()).toMatchObject({ status: 'error', error: 'destinationMissing' });
  });

  it.each([
    [ErrorCode.PLAN_EXPIRED, 'planExpired'],
    [ErrorCode.PHOTO_LIMIT_REACHED, 'photoLimitReached'],
  ] as const)(
    'stops on %s (ADR 0026) and uploads the file again after resuming',
    async (code, error) => {
      const folder = fakeFolder('Export');
      folder.put('IMG_1.jpg', 10);
      const { engine, uploads } = makeEngine();
      await setUp(engine, folder);
      await engine.tick();
      uploads.finish('IMG_1.jpg', { ok: false, error: apiError(code) });
      await flush();
      expect(engine.getSnapshot()).toMatchObject({ status: 'error', error });
      expect(engine.getSnapshot().stats.failed).toBe(0);
      await engine.resume();
      expect(engine.getSnapshot().status).toBe('running');
      await engine.tick(); // the second scan sees the file unchanged
      expect(uploads.names()).toEqual(['IMG_1.jpg']);
    },
  );

  it('stops when the watched folder is gone', async () => {
    const folder = fakeFolder('Export');
    const { engine } = makeEngine();
    await setUp(engine, folder);
    folder.vanish();
    await engine.tick();
    expect(engine.getSnapshot()).toMatchObject({ status: 'error', error: 'folderMissing' });
  });

  it('does not sync in a second tab', async () => {
    const folder = fakeFolder('Export');
    const { engine } = makeEngine({ lockFree: false });
    await setUp(engine, folder);
    expect(engine.getSnapshot()).toMatchObject({ status: 'error', error: 'otherTab' });
  });

  it('pauses and resumes', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads } = makeEngine();
    await setUp(engine, folder);
    engine.pause();
    expect(engine.getSnapshot().status).toBe('paused');
    await engine.tick();
    expect(uploads.names()).toEqual([]);
    await engine.resume();
    await engine.tick();
    expect(uploads.names()).toEqual(['IMG_1.jpg']);
  });

  describe('after a reload', () => {
    async function saved(store: SyncStore, folder: ReturnType<typeof fakeFolder>, owner: string) {
      const job: SyncJob = {
        jobId: 'job-0',
        owner,
        handle: folder.handle,
        destination: { id: 'dest-1', name: 'Event' },
        includeSubfolders: true,
        includeExisting: true,
        createdAt: 1,
      };
      await store.saveJob(job);
      await store.record('job-0', [
        { path: 'done.jpg', entry: { sig: '10:1000', outcome: 'uploaded' } },
      ]);
    }

    it('resumes on its own when the browser kept the permission, skipping the ledger', async () => {
      const folder = fakeFolder('Export');
      folder.put('done.jpg', 10, 1000);
      folder.put('new.jpg', 10, 2000);
      const store = memorySyncStore();
      await saved(store, folder, 'owner-1');
      const { engine, uploads } = makeEngine({ store });
      await engine.init();
      expect(engine.getSnapshot().status).toBe('running');
      expect(engine.getSnapshot().job?.folderName).toBe('Export');
      // Totals since set-up, from the saved ledger.
      expect(engine.getSnapshot().stats.uploaded).toBe(1);
      await engine.tick();
      expect(uploads.names()).toEqual(['new.jpg']);
    });

    it('asks for the permission again with a click', async () => {
      const folder = fakeFolder('Export', 'prompt');
      const store = memorySyncStore();
      await saved(store, folder, 'owner-1');
      const { engine } = makeEngine({ store });
      await engine.init();
      expect(engine.getSnapshot().status).toBe('needsPermission');
      await engine.resume();
      expect(folder.state.requested).toBe(1);
      expect(engine.getSnapshot().status).toBe('running');
    });

    it('forgets another account’s set-up', async () => {
      const folder = fakeFolder('Export');
      const store = memorySyncStore();
      await saved(store, folder, 'someone-else');
      const { engine } = makeEngine({ store });
      await engine.init();
      expect(engine.getSnapshot().status).toBe('idle');
      expect(await store.loadJob()).toBeNull();
    });
  });

  it('resumes an upload cut off by a reload with the same key', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const store = memorySyncStore();
    const first = makeEngine({ store });
    await setUp(first.engine, folder);
    await first.engine.tick();
    const key = first.uploads.keyOf('IMG_1.jpg');
    expect(key).toBeDefined();
    first.engine.dispose(); // the tab closed mid-upload

    const second = makeEngine({ store });
    await second.engine.init();
    await second.engine.tick();
    await second.engine.tick();
    expect(second.uploads.keyOf('IMG_1.jpg')).toBe(key);
  });

  it('starts over with a new key when the saved one is used up (CONFLICT)', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads, clock } = makeEngine({ retryDelaysMs: [1000] });
    await setUp(engine, folder);
    await engine.tick();
    const key = uploads.keyOf('IMG_1.jpg');
    uploads.finish('IMG_1.jpg', { ok: false, error: apiError(ErrorCode.CONFLICT) });
    await flush();
    clock.now += 1000;
    await engine.tick();
    expect(uploads.keyOf('IMG_1.jpg')).toBeDefined();
    expect(uploads.keyOf('IMG_1.jpg')).not.toBe(key);
  });

  it('stop forgets the set-up and cancels queued uploads', async () => {
    const folder = fakeFolder('Export');
    folder.put('IMG_1.jpg', 10);
    const { engine, uploads, store } = makeEngine();
    await setUp(engine, folder);
    await engine.tick();
    expect(uploads.names()).toEqual(['IMG_1.jpg']);
    await engine.stop();
    expect(uploads.names()).toEqual([]);
    expect(engine.getSnapshot().status).toBe('idle');
    expect(await store.loadJob()).toBeNull();
  });
});

describe('isSyncableName', () => {
  it('takes the upload allowlist and leaves hidden files and sidecars out', () => {
    expect(isSyncableName('IMG_1.JPG')).toBe(true);
    expect(isSyncableName('clip.mov')).toBe(true);
    expect(isSyncableName('IMG_1.xmp')).toBe(false);
    expect(isSyncableName('IMG_1.dng')).toBe(false);
    expect(isSyncableName('._IMG_1.jpg')).toBe(false);
  });
});
