import type { SyncDirectoryHandle } from './fs-access';

/**
 * What folder sync keeps in this browser's IndexedDB (ADR 0014): the watched folder's handle (so
 * a reload can resume after one click) and a ledger of the files already handled, so a restart
 * doesn't ask the API about thousands of files again. Nothing here leaves the browser; the API's
 * NAME_TAKEN stays the authority on what is already in the drive.
 */

export interface SyncDestination {
  /** Drive folder id; null for the drive root. */
  id: string | null;
  name: string;
}

export interface SyncJob {
  /** New for every set-up: the ledger belongs to one job. */
  jobId: string;
  /** The photographer's user id (GET /me): another account in this browser doesn't resume it. */
  owner: string;
  handle: SyncDirectoryHandle;
  destination: SyncDestination;
  includeSubfolders: boolean;
  /** False: files already in the folder at set-up are left alone (`baseline`). */
  includeExisting: boolean;
  createdAt: number;
}

/**
 * How a file ended: `uploaded`; `exists` (NAME_TAKEN: a file with that name is already in the
 * drive folder); `skipped` (refused before upload: type, size, path); `baseline` (there at set-up
 * and not to be uploaded). `pending`: queued, not finished yet; its `clientUploadId` is sent again
 * after a reload, so the API resumes that upload instead of answering NAME_TAKEN for its own
 * half-done file.
 */
export type LedgerOutcome = 'uploaded' | 'exists' | 'skipped' | 'baseline' | 'pending';

export interface LedgerEntry {
  /** fileSignature at the time. */
  sig: string;
  outcome: LedgerOutcome;
  /** The upload's idempotency key (uploadInitBodySchema.clientUploadId); `pending` only. */
  clientUploadId?: string;
}

export interface SyncStore {
  loadJob(): Promise<SyncJob | null>;
  saveJob(job: SyncJob): Promise<void>;
  /** Forgets the job and its ledger. */
  clear(): Promise<void>;
  loadLedger(jobId: string): Promise<Map<string, LedgerEntry>>;
  record(jobId: string, entries: { path: string; entry: LedgerEntry }[]): Promise<void>;
}

const DB_NAME = 'snap-folder-sync';
const DB_VERSION = 1;
const JOBS = 'jobs';
const LEDGER = 'ledger';
const CURRENT = 'current';
/** Ledger keys are `jobId␀path`, so one key range reads a job's ledger. */
const SEP = '\u0000';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function indexedDbSyncStore(factory: IDBFactory = indexedDB): SyncStore {
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(JOBS)) d.createObjectStore(JOBS);
        if (!d.objectStoreNames.contains(LEDGER)) d.createObjectStore(LEDGER);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opening = null;
        reject(req.error ?? new Error('IndexedDB open failed'));
      };
    });
    return opening;
  };

  return {
    async loadJob() {
      const tx = (await db()).transaction(JOBS, 'readonly');
      const job: unknown = await request(tx.objectStore(JOBS).get(CURRENT));
      return (job as SyncJob | undefined) ?? null;
    },
    async saveJob(job) {
      const tx = (await db()).transaction(JOBS, 'readwrite');
      tx.objectStore(JOBS).put(job, CURRENT);
      await done(tx);
    },
    async clear() {
      const tx = (await db()).transaction([JOBS, LEDGER], 'readwrite');
      tx.objectStore(JOBS).clear();
      tx.objectStore(LEDGER).clear();
      await done(tx);
    },
    async loadLedger(jobId) {
      const tx = (await db()).transaction(LEDGER, 'readonly');
      const range = IDBKeyRange.bound(`${jobId}${SEP}`, `${jobId}${SEP}￿`);
      const store = tx.objectStore(LEDGER);
      const [keys, values] = await Promise.all([
        request(store.getAllKeys(range)),
        request(store.getAll(range)),
      ]);
      const ledger = new Map<string, LedgerEntry>();
      keys.forEach((key, i) => {
        if (typeof key === 'string')
          ledger.set(key.slice(jobId.length + 1), values[i] as LedgerEntry);
      });
      return ledger;
    },
    async record(jobId, entries) {
      if (entries.length === 0) return;
      const tx = (await db()).transaction(LEDGER, 'readwrite');
      const store = tx.objectStore(LEDGER);
      for (const { path, entry } of entries) store.put(entry, `${jobId}${SEP}${path}`);
      await done(tx);
    },
  };
}

/** The same store in memory (tests, and browsers where IndexedDB fails to open). */
export function memorySyncStore(): SyncStore {
  let job: SyncJob | null = null;
  const ledger = new Map<string, Map<string, LedgerEntry>>();
  return {
    loadJob: () => Promise.resolve(job),
    saveJob: (next) => {
      job = next;
      return Promise.resolve();
    },
    clear: () => {
      job = null;
      ledger.clear();
      return Promise.resolve();
    },
    loadLedger: (jobId) => Promise.resolve(new Map(ledger.get(jobId) ?? [])),
    record: (jobId, entries) => {
      const map = ledger.get(jobId) ?? new Map<string, LedgerEntry>();
      for (const { path, entry } of entries) map.set(path, entry);
      ledger.set(jobId, map);
      return Promise.resolve();
    },
  };
}
