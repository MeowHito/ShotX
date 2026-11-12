'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useUploads } from '@/components/upload/upload-context';
import type { ClientFolderSyncConfig } from '@/lib/server/config';
import { useMe } from '@/lib/studio/queries';
import {
  FolderSyncEngine,
  type SyncLock,
  type SyncSetup,
  type SyncSnapshot,
} from '@/lib/sync/engine';
import { folderSyncSupported } from '@/lib/sync/fs-access';
import { indexedDbSyncStore, memorySyncStore, type SyncStore } from '@/lib/sync/store';

/**
 * Folder sync for the whole studio session (ADR 0014): the provider sits in the studio layout,
 * so syncing goes on while the photographer browses other studio pages. Closing the tab stops it.
 */

interface FolderSyncValue {
  snapshot: SyncSnapshot;
  setup: (setup: SyncSetup) => Promise<void>;
  resume: () => Promise<void>;
  pause: () => void;
  stop: () => Promise<void>;
}

const FolderSyncContext = createContext<FolderSyncValue | null>(null);

export function useFolderSync(): FolderSyncValue {
  const value = useContext(FolderSyncContext);
  if (value === null) throw new Error('useFolderSync outside <FolderSyncProvider>');
  return value;
}

/** Null outside the provider (the aside's "syncing" dot on pages rendered on their own). */
export function useOptionalFolderSync(): FolderSyncValue | null {
  return useContext(FolderSyncContext);
}

/** Shown in the server render and until the engine has loaded. */
const LOADING: SyncSnapshot = {
  status: 'loading',
  error: null,
  job: null,
  stats: { uploaded: 0, exists: 0, skipped: 0, failed: 0, uploading: 0, waiting: 0, ignored: 0 },
  lastScanAt: null,
  recent: [],
};

const LOCK_NAME = 'snap-folder-sync';

/**
 * One syncing tab per browser. A tab holding a Web Lock is also never frozen or discarded by
 * Chrome while it is in the background. Release may come before the grant (StrictMode, a quick
 * unmount); the grant then lets go at once.
 */
function webLock(): SyncLock {
  /** The request that may hold the lock; a grant for any other one lets go at once. */
  let current: object | null = null;
  let release: (() => void) | null = null;
  return {
    acquire: () =>
      new Promise<boolean>((resolve) => {
        const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
        if (locks === undefined) {
          resolve(true);
          return;
        }
        const token = {};
        current = token;
        locks
          .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
            if (lock === null || current !== token) {
              resolve(false);
              return undefined;
            }
            resolve(true);
            return new Promise<void>((done) => {
              release = done;
            });
          })
          .catch(() => resolve(false));
      }),
    release: () => {
      current = null;
      release?.();
      release = null;
    },
  };
}

const RECENT_MAX = 30;

export function FolderSyncProvider({
  children,
  config,
  testing,
}: {
  children: ReactNode;
  config: ClientFolderSyncConfig;
  /** Tests: a store in memory and whether the browser counts as supported (jsdom has no picker). */
  testing?: { store: SyncStore; supported: boolean };
}) {
  const { addFiles, watch, remove } = useUploads();
  // StudioGate renders the studio only once GET /me answered: a set-up resumes for this account only.
  const owner = useMe().data?.id ?? '';

  const [engine] = useState(() => {
    const supported =
      testing?.supported ?? (typeof window !== 'undefined' && folderSyncSupported(window));
    return new FolderSyncEngine({
      store: testing?.store ?? (supported ? indexedDbSyncStore() : memorySyncStore()),
      lock: webLock(),
      owner,
      supported,
      config: { ...config, recentMax: RECENT_MAX },
    });
  });

  // The upload queue as of this render (set before init runs: effects run in order).
  useEffect(() => {
    engine.setUploads({
      add: (file, relativePath, destinationId, clientUploadId) => {
        const [result] = addFiles([{ file, relativePath, clientUploadId }], destinationId, {
          onNameConflict: 'fail',
        });
        if (result === undefined || result.status === 'duplicate') return { status: 'duplicate' };
        return result.status === 'queued'
          ? { status: 'queued', id: result.id }
          : { status: 'rejected' };
      },
      watch: (listener) =>
        watch((id, outcome) =>
          listener(id, outcome.ok ? { ok: true } : { ok: false, error: outcome.error }),
        ),
      remove,
    });
  }, [engine, addFiles, watch, remove]);

  useEffect(() => {
    void engine.init();
    return () => engine.dispose();
  }, [engine]);

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, () => LOADING);

  // Leaving the page stops the sync: ask first while it runs.
  const running = snapshot.status === 'running';
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [running]);

  const value = useMemo<FolderSyncValue>(
    () => ({
      snapshot,
      setup: (setup) => engine.setup(setup),
      resume: () => engine.resume(),
      pause: () => engine.pause(),
      stop: () => engine.stop(),
    }),
    [snapshot, engine],
  );

  return <FolderSyncContext.Provider value={value}>{children}</FolderSyncContext.Provider>;
}
