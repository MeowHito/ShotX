import { ErrorCode } from '@shotx/shared';
import { isApiError } from '../api/errors';
import { readPermission, requestReadPermission, type SyncDirectoryHandle } from './fs-access';
import { fileSignature, type ScannedFile, type ScanResult, scanFolder } from './scan';
import type { LedgerEntry, LedgerOutcome, SyncDestination, SyncJob, SyncStore } from './store';

/**
 * Folder sync (ADR 0014): watches a folder on the photographer's computer (Lightroom's export
 * folder) and uploads every new photo into a drive folder, from the browser alone.
 *
 * Every `intervalMs` it scans the folder. A file is uploaded once two scans in a row saw the same
 * size and modification time and it was last written at least `settleMs` ago (the exporting app
 * has finished writing it, and a post-processor such as a Lightroom watermark plugin, which
 * rewrites the file right after export, is done too), and only if the ledger hasn't handled that
 * version yet. Uploads go through the studio's normal upload queue with
 * `onNameConflict: 'fail'`, so a name already in the drive folder is NAME_TAKEN, recorded as
 * `exists` and never uploaded twice, from this browser or any other. At most `maxQueued` files
 * are in the queue at once; the rest wait for the next scans.
 */

export type SyncStatus =
  | 'loading'
  | 'unsupported'
  /** No folder set up. */
  | 'idle'
  /** Set up, but the browser needs a click to read the folder again (after a reload). */
  | 'needsPermission'
  | 'running'
  | 'paused'
  /** Stopped by a problem the photographer must fix (SyncErrorCode). */
  | 'error';

export type SyncErrorCode =
  /** The watched folder was moved, renamed or deleted. */
  | 'folderMissing'
  /** The drive folder was deleted or moved to the trash. */
  | 'destinationMissing'
  /** Another tab of this browser is syncing. */
  | 'otherTab'
  /** IndexedDB or another browser part failed. */
  | 'browser';

export type RecentOutcome = Exclude<LedgerOutcome, 'baseline' | 'pending'> | 'failed';

export interface SyncRecent {
  path: string;
  outcome: RecentOutcome;
  at: number;
}

export interface SyncStats {
  uploaded: number;
  exists: number;
  skipped: number;
  /** Gave up after the retries (tried again after a reload). */
  failed: number;
  /** In the upload queue now. */
  uploading: number;
  /** Seen and still to upload (not yet stable, or waiting for a queue slot). */
  waiting: number;
  /** Other file types in the folder, not synced. */
  ignored: number;
}

export interface SyncSnapshot {
  status: SyncStatus;
  error: SyncErrorCode | null;
  job: {
    folderName: string;
    destination: SyncDestination;
    includeSubfolders: boolean;
  } | null;
  stats: SyncStats;
  lastScanAt: number | null;
  recent: SyncRecent[];
}

export type SyncAddResult =
  { status: 'queued'; id: string } | { status: 'rejected' } | { status: 'duplicate' };

export type SyncUploadOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * ADR 0021: turns a synced file into what is uploaded (the photographer's watermark burned in).
 * Same name; it may return the file itself (a video, or a type it doesn't handle). A throw counts
 * as a failed attempt of that version, retried like a failed upload, so a photo is never sent
 * without the watermark the photographer asked for.
 */
export type SyncPrepare = (file: File) => Promise<File>;

/** The studio upload queue, as the engine sees it. */
export interface SyncUploads {
  add(
    file: File,
    relativePath: string | null,
    destinationId: string | null,
    clientUploadId: string,
  ): SyncAddResult;
  watch(listener: (id: string, outcome: SyncUploadOutcome) => void): () => void;
  remove(id: string): void;
}

/** One sync per browser: a Web Lock held by the tab that syncs. */
export interface SyncLock {
  acquire(): Promise<boolean>;
  release(): void;
}

export interface SyncEngineConfig {
  intervalMs: number;
  /**
   * How long a file must be untouched (now − lastModified) before it is uploaded. A version
   * uploaded too early can't be replaced: the rewritten file is then NAME_TAKEN (`exists`).
   */
  settleMs: number;
  maxQueued: number;
  maxDepth: number;
  /** Waits before the retries of a failed upload; after the last one it counts as failed. */
  retryDelaysMs: readonly number[];
  recentMax: number;
}

export interface SyncEngineDeps {
  store: SyncStore;
  /** Null until setUploads (the React provider passes the queue after render). */
  uploads?: SyncUploads | null;
  lock: SyncLock;
  /** The signed-in photographer (SyncJob.owner). */
  owner: string;
  config: SyncEngineConfig;
  supported: boolean;
  scan?: typeof scanFolder;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  newId?: () => string;
}

export interface SyncSetup {
  handle: SyncDirectoryHandle;
  destination: SyncDestination;
  includeSubfolders: boolean;
  includeExisting: boolean;
}

/** Before setUploads: nothing can be queued yet. */
const NO_UPLOADS: SyncUploads = {
  add: () => ({ status: 'duplicate' }),
  watch: () => () => undefined,
  remove: () => undefined,
};

const EMPTY_STATS: SyncStats = {
  uploaded: 0,
  exists: 0,
  skipped: 0,
  failed: 0,
  uploading: 0,
  waiting: 0,
  ignored: 0,
};

interface InFlight {
  file: ScannedFile;
  sig: string;
}

interface Failure {
  sig: string;
  count: number;
  retryAt: number;
}

export class FolderSyncEngine {
  private readonly deps: Required<Omit<SyncEngineDeps, 'uploads'>>;
  private uploads: SyncUploads = NO_UPLOADS;
  private listeners = new Set<() => void>();
  private snapshot: SyncSnapshot = {
    status: 'loading',
    error: null,
    job: null,
    stats: EMPTY_STATS,
    lastScanAt: null,
    recent: [],
  };

  private job: SyncJob | null = null;
  private ledger = new Map<string, LedgerEntry>();
  /** The previous scan: path → signature (a file is stable when it didn't change since). */
  private previous: Map<string, string> | null = null;
  private inFlight = new Map<string, InFlight>();
  private inFlightPaths = new Set<string>();
  private failures = new Map<string, Failure>();
  private prepare: SyncPrepare | null = null;
  private counts = { uploaded: 0, exists: 0, skipped: 0, failed: 0 };
  private timer: unknown = null;
  private scanning = false;
  private locked = false;
  private unwatch: (() => void) | null = null;
  private disposed = false;
  /** Bumped by every init, so a superseded init (StrictMode remount) stops at its next await. */
  private generation = 0;

  constructor({ uploads, ...deps }: SyncEngineDeps) {
    if (uploads) this.uploads = uploads;
    this.deps = {
      scan: scanFolder,
      now: Date.now,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      newId: () => crypto.randomUUID(),
      ...deps,
    };
  }

  /**
   * ADR 0021: a step run on each file before it is queued (the watermark), or null. Set again
   * whenever the photographer saves new settings; files already queued keep what they had.
   */
  setPrepare(prepare: SyncPrepare | null): void {
    this.prepare = prepare;
  }

  /** The studio upload queue (again whenever its functions change). */
  setUploads(uploads: SyncUploads): void {
    this.uploads = uploads;
    if (this.unwatch !== null) {
      this.unwatch();
      this.unwatch = uploads.watch((id, outcome) => void this.onOutcome(id, outcome));
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  private set(patch: Partial<SyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setStats(patch: Partial<SyncStats>) {
    this.set({ stats: { ...this.snapshot.stats, ...patch } });
  }

  private jobView(job: SyncJob): SyncSnapshot['job'] {
    return {
      folderName: job.handle.name,
      destination: job.destination,
      includeSubfolders: job.includeSubfolders,
    };
  }

  /** Loads a saved job and resumes it when the browser still lets the page read the folder. */
  async init(): Promise<void> {
    const gen = ++this.generation;
    this.disposed = false;
    const stale = () => gen !== this.generation || this.disposed;
    if (!this.deps.supported) {
      this.set({ status: 'unsupported' });
      return;
    }
    try {
      const job = await this.deps.store.loadJob();
      if (stale()) return;
      if (job === null || this.deps.owner === '') {
        this.set({ status: 'idle' });
        return;
      }
      if (job.owner !== this.deps.owner) {
        // Another photographer's set-up in this browser: never upload into their drive.
        await this.deps.store.clear();
        this.set({ status: 'idle' });
        return;
      }
      this.job = job;
      const ledger = await this.deps.store.loadLedger(job.jobId);
      if (stale()) return;
      this.ledger = ledger;
      // The totals since set-up survive reloads (the ledger has every outcome).
      this.counts = { uploaded: 0, exists: 0, skipped: 0, failed: 0 };
      for (const { outcome } of ledger.values()) {
        if (outcome === 'uploaded' || outcome === 'exists' || outcome === 'skipped') {
          this.counts[outcome] += 1;
        }
      }
      this.set({ job: this.jobView(job), stats: { ...EMPTY_STATS, ...this.counts } });
      const permission = await readPermission(job.handle);
      if (stale()) return;
      if (permission === 'granted') await this.run();
      else this.set({ status: 'needsPermission' });
    } catch {
      this.set({ status: 'error', error: 'browser' });
    }
  }

  /** Sets up a new sync (replaces the old one and its ledger) and starts it. */
  async setup(setup: SyncSetup): Promise<void> {
    this.halt();
    this.cancelInFlight();
    const job: SyncJob = {
      jobId: this.deps.newId(),
      owner: this.deps.owner,
      handle: setup.handle,
      destination: setup.destination,
      includeSubfolders: setup.includeSubfolders,
      includeExisting: setup.includeExisting,
      createdAt: this.deps.now(),
    };
    try {
      await this.deps.store.clear();
      await this.deps.store.saveJob(job);
    } catch {
      this.set({ status: 'error', error: 'browser' });
      return;
    }
    this.job = job;
    this.ledger = new Map();
    this.counts = { uploaded: 0, exists: 0, skipped: 0, failed: 0 };
    this.failures.clear();
    this.set({ job: this.jobView(job), stats: EMPTY_STATS, recent: [], lastScanAt: null });
    if (!setup.includeExisting) await this.baseline(job);
    await this.run();
  }

  /** Resumes after a pause, a reload or an error (call from a click: it may ask for permission). */
  async resume(): Promise<void> {
    const job = this.job;
    if (job === null) return;
    let permission = await readPermission(job.handle).catch(() => 'prompt' as const);
    if (permission !== 'granted') {
      permission = await requestReadPermission(job.handle).catch(() => 'denied' as const);
    }
    if (permission !== 'granted') {
      this.set({ status: 'needsPermission' });
      return;
    }
    this.failures.clear();
    await this.run();
  }

  /** Stops scanning; uploads already in the queue finish. */
  pause(): void {
    if (this.snapshot.status !== 'running') return;
    this.stopTimer();
    this.set({ status: 'paused' });
  }

  /** Forgets the set-up and its ledger; uploads in the queue are cancelled. */
  async stop(): Promise<void> {
    this.halt();
    this.cancelInFlight();
    this.job = null;
    this.ledger = new Map();
    try {
      await this.deps.store.clear();
    } catch {
      // Nothing to resume from anyway.
    }
    this.set({ status: 'idle', error: null, job: null, stats: EMPTY_STATS, recent: [] });
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.unwatch?.();
    this.unwatch = null;
    this.releaseLock();
  }

  private cancelInFlight() {
    for (const id of [...this.inFlight.keys()]) this.uploads.remove(id);
    this.inFlight.clear();
    this.inFlightPaths.clear();
  }

  private halt() {
    this.stopTimer();
    this.previous = null;
  }

  private stopTimer() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private releaseLock() {
    // Also when the grant is still pending (the lock lets go of a late grant).
    this.deps.lock.release();
    this.locked = false;
  }

  private async run() {
    if (this.disposed) return;
    if (!this.locked) {
      this.locked = await this.deps.lock.acquire().catch(() => false);
      if (!this.locked) {
        this.set({ status: 'error', error: 'otherTab' });
        return;
      }
    }
    this.unwatch ??= this.uploads.watch((id, outcome) => void this.onOutcome(id, outcome));
    this.previous = null;
    this.set({ status: 'running', error: null });
    await this.tick();
  }

  private schedule() {
    this.stopTimer();
    if (this.disposed || this.snapshot.status !== 'running') return;
    this.timer = this.deps.setTimer(() => void this.tick(), this.deps.config.intervalMs);
  }

  private async scan(job: SyncJob): Promise<ScanResult | null> {
    try {
      return await this.deps.scan(job.handle, {
        includeSubfolders: job.includeSubfolders,
        maxDepth: this.deps.config.maxDepth,
      });
    } catch (error) {
      this.stopTimer();
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.set({ status: 'needsPermission' });
      } else {
        this.set({ status: 'error', error: 'folderMissing' });
      }
      return null;
    }
  }

  /** "Only new files": everything in the folder now is recorded as `baseline`. */
  private async baseline(job: SyncJob) {
    const result = await this.scan(job);
    if (result === null) return;
    const entries = result.files.map((f) => ({
      path: f.path,
      entry: { sig: fileSignature(f), outcome: 'baseline' as const },
    }));
    for (const { path, entry } of entries) this.ledger.set(path, entry);
    await this.deps.store.record(job.jobId, entries).catch(() => undefined);
  }

  /** One pass: scan, then queue the stable files the ledger hasn't handled. Public for tests. */
  async tick(): Promise<void> {
    const job = this.job;
    if (job === null || this.scanning || this.snapshot.status !== 'running') return;
    this.scanning = true;
    try {
      const result = await this.scan(job);
      if (result === null || this.snapshot.status !== 'running' || this.job !== job) return;
      const now = this.deps.now();
      const previous = this.previous;
      this.previous = new Map(result.files.map((f) => [f.path, fileSignature(f)]));

      const retryLater = (f: ScannedFile) => {
        const failure = this.failures.get(f.path);
        return failure !== undefined && failure.sig === fileSignature(f) && failure.retryAt > now;
      };
      const pending = result.files.filter((file) => {
        const sig = fileSignature(file);
        if (this.handled(file.path, sig) || this.inFlightPaths.has(file.path)) return false;
        const failure = this.failures.get(file.path);
        // Gave up on this version after the retries; a reload or a new export tries again.
        return !(
          failure !== undefined &&
          failure.sig === sig &&
          failure.count > this.deps.config.retryDelaysMs.length
        );
      });
      // Oldest first, and only files that didn't change since the previous scan and have been
      // left alone for settleMs (a watermark plugin may still rewrite a fresh export).
      const settled = (f: ScannedFile) => now - f.lastModified >= this.deps.config.settleMs;
      const ready = pending
        .filter((f) => previous?.get(f.path) === fileSignature(f) && settled(f) && !retryLater(f))
        .sort((a, b) => a.lastModified - b.lastModified || a.path.localeCompare(b.path));

      const skipped: { path: string; entry: LedgerEntry }[] = [];
      for (const file of ready) {
        if (this.inFlight.size >= this.deps.config.maxQueued) break;
        const sig = fileSignature(file);
        let data: File;
        try {
          data = await file.handle.getFile();
        } catch {
          continue; // gone or locked: the next scan decides
        }
        if (fileSignature(data) !== sig) continue; // written again since the scan
        // The key saved for this version, if a reload cut its upload off; else a new one, saved
        // before the upload starts.
        const saved = this.ledger.get(file.path);
        const clientUploadId =
          saved?.outcome === 'pending' && saved.sig === sig && saved.clientUploadId
            ? saved.clientUploadId
            : this.deps.newId();
        if (saved?.clientUploadId !== clientUploadId) {
          const entry: LedgerEntry = { sig, outcome: 'pending', clientUploadId };
          this.ledger.set(file.path, entry);
          await this.deps.store
            .record(job.jobId, [{ path: file.path, entry }])
            .catch(() => undefined);
        }
        let upload = data;
        if (this.prepare !== null) {
          try {
            upload = await this.prepare(data);
          } catch {
            this.noteFailure(file.path, sig);
            continue;
          }
        }
        const added = this.uploads.add(
          upload,
          file.relativePath,
          job.destination.id,
          clientUploadId,
        );
        if (added.status === 'queued') {
          this.inFlight.set(added.id, { file, sig });
          this.inFlightPaths.add(file.path);
        } else if (added.status === 'rejected') {
          const entry: LedgerEntry = { sig, outcome: 'skipped' };
          this.ledger.set(file.path, entry);
          skipped.push({ path: file.path, entry });
          this.counts.skipped += 1;
          this.pushRecent(file.path, 'skipped');
        }
        // 'duplicate': the same file is in the queue from a manual upload; look again later.
      }
      if (skipped.length > 0)
        await this.deps.store.record(job.jobId, skipped).catch(() => undefined);

      this.set({ lastScanAt: now });
      this.setStats({
        ...this.counts,
        uploading: this.inFlight.size,
        waiting: pending.filter((f) => !this.inFlightPaths.has(f.path)).length,
        ignored: result.ignored,
      });
    } finally {
      this.scanning = false;
      this.schedule();
    }
  }

  /** Whether this version of the file is done (uploaded, exists, skipped or baseline). */
  private handled(path: string, sig: string): boolean {
    const entry = this.ledger.get(path);
    return entry !== undefined && entry.sig === sig && entry.outcome !== 'pending';
  }

  private pushRecent(path: string, outcome: RecentOutcome) {
    const recent = [{ path, outcome, at: this.deps.now() }, ...this.snapshot.recent];
    this.set({ recent: recent.slice(0, this.deps.config.recentMax) });
  }

  private async onOutcome(id: string, outcome: SyncUploadOutcome) {
    const flight = this.inFlight.get(id);
    const job = this.job;
    if (flight === undefined || job === null) return;
    this.inFlight.delete(id);
    this.inFlightPaths.delete(flight.file.path);
    this.uploads.remove(id);

    const exists = !outcome.ok && isApiError(outcome.error, ErrorCode.NAME_TAKEN);
    if (outcome.ok || exists) {
      const entry: LedgerEntry = { sig: flight.sig, outcome: outcome.ok ? 'uploaded' : 'exists' };
      this.ledger.set(flight.file.path, entry);
      this.failures.delete(flight.file.path);
      if (outcome.ok) this.counts.uploaded += 1;
      else this.counts.exists += 1;
      this.pushRecent(flight.file.path, entry.outcome as RecentOutcome);
      await this.deps.store
        .record(job.jobId, [{ path: flight.file.path, entry }])
        .catch(() => undefined);
    } else if (!outcome.ok && isApiError(outcome.error, ErrorCode.NOT_FOUND)) {
      // The drive folder is gone: stop rather than fail every file.
      this.stopTimer();
      this.set({ status: 'error', error: 'destinationMissing' });
    } else {
      if (!outcome.ok && isApiError(outcome.error, ErrorCode.CONFLICT)) {
        // The saved key belongs to an upload that is over (completed, failed or expired): the
        // retry starts with a new key (and a completed one then answers NAME_TAKEN: exists).
        const entry: LedgerEntry = {
          sig: flight.sig,
          outcome: 'pending',
          clientUploadId: this.deps.newId(),
        };
        this.ledger.set(flight.file.path, entry);
        await this.deps.store
          .record(job.jobId, [{ path: flight.file.path, entry }])
          .catch(() => undefined);
      }
      this.noteFailure(flight.file.path, flight.sig);
    }
    this.setStats({ ...this.counts, uploading: this.inFlight.size });
  }

  /** One failed attempt of this version: retried after the next delay, then counted as failed. */
  private noteFailure(path: string, sig: string) {
    const previous = this.failures.get(path);
    const count = previous !== undefined && previous.sig === sig ? previous.count + 1 : 1;
    const delay = this.deps.config.retryDelaysMs[count - 1];
    this.failures.set(path, { sig, count, retryAt: this.deps.now() + (delay ?? 0) });
    if (delay === undefined) {
      this.counts.failed += 1;
      this.pushRecent(path, 'failed');
    }
  }
}
