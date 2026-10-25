'use client';

import { type DriveFile, folderRefFromId } from '@shotx/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useApiClient } from '@/components/providers';
import { driveKeys } from '@/lib/drive/queries';
import type { ClientUploadConfig } from '@/lib/server/config';
import type { PickedFile } from '@/lib/upload/dropped-files';
import { precheckFile } from '@/lib/upload/precheck';
import {
  createDriveUploader,
  type DriveUploader,
  type DriveUploaderOptions,
  type DriveUppyFile,
} from '@/lib/upload/uploader';

export type UploadStatus = 'queued' | 'uploading' | 'complete' | 'error' | 'rejected';

export interface UploadEntry {
  id: string;
  name: string;
  status: UploadStatus;
  percent: number;
  error?: unknown;
}

interface UploadContextValue {
  entries: UploadEntry[];
  addFiles: (files: PickedFile[], folderId: string | null) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  clearFinished: () => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

export function useUploads(): UploadContextValue {
  const value = useContext(UploadContext);
  if (value === null) throw new Error('useUploads outside <UploadProvider>');
  return value;
}

function statusOf(file: DriveUppyFile, failed: boolean): UploadStatus {
  if (file.progress.uploadComplete) return 'complete';
  if (failed || file.error) return 'error';
  if (file.progress.uploadStarted) return 'uploading';
  return 'queued';
}

export function UploadProvider({
  children,
  config,
  uploaderOptions,
}: {
  children: ReactNode;
  config: ClientUploadConfig;
  /** Overrides for tests (e.g. a fake S3 part upload). */
  uploaderOptions?: Partial<DriveUploaderOptions>;
}) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [rejected, setRejected] = useState<UploadEntry[]>([]);

  const [uploader] = useState<DriveUploader>(() =>
    createDriveUploader({
      api,
      partBytes: config.partBytes,
      partConcurrency: config.partConcurrency,
      onUploaded: (file: DriveFile) => {
        void queryClient.invalidateQueries({
          queryKey: driveKeys.children(folderRefFromId(file.folderId)),
        });
        void queryClient.invalidateQueries({ queryKey: driveKeys.usage });
      },
      onFoldersCreated: (folders) => {
        for (const folder of folders) {
          void queryClient.invalidateQueries({
            queryKey: driveKeys.children(folderRefFromId(folder.parentId)),
          });
        }
      },
      ...uploaderOptions,
    }),
  );
  // Not destroyed on unmount: StrictMode remounts with the same state, and the provider lives for
  // the whole studio session (uploads continue while the user browses folders).

  const { uppy } = uploader;
  const subscribe = useCallback(
    (onChange: () => void) => {
      uppy.on('state-update', onChange);
      return () => uppy.off('state-update', onChange);
    },
    [uppy],
  );
  const uppyState = useSyncExternalStore(
    subscribe,
    () => uppy.getState(),
    () => uppy.getState(),
  );

  const entries = useMemo<UploadEntry[]>(() => {
    const live = Object.values(uppyState.files).map((file) => {
      const failed = Boolean(file.error);
      return {
        id: file.id,
        name: file.name ?? '',
        status: statusOf(file, failed),
        percent: file.progress.percentage ?? 0,
        error: failed ? uploader.errorFor(file.id) : undefined,
      };
    });
    return [...rejected, ...live];
  }, [uppyState, rejected, uploader]);

  const addFiles = useCallback(
    (files: PickedFile[], folderId: string | null) => {
      const rejectedNow: UploadEntry[] = [];
      for (const { file, relativePath } of files) {
        const check = precheckFile(file, config.maxBytes, relativePath);
        if (!check.ok) {
          rejectedNow.push({
            id: `rejected-${crypto.randomUUID()}`,
            name: relativePath ? `${relativePath}/${file.name}` : file.name,
            status: 'rejected',
            percent: 0,
            error: check.error,
          });
          continue;
        }
        try {
          uppy.addFile({
            name: file.name,
            type: check.mime,
            data: file,
            meta: { folderId, drivePath: relativePath, mime: check.mime },
          });
        } catch {
          // Uppy refuses exact duplicates already in the queue; nothing to do.
        }
      }
      if (rejectedNow.length > 0) setRejected((prev) => [...prev, ...rejectedNow]);
    },
    [uppy, config.maxBytes],
  );

  const value = useMemo<UploadContextValue>(
    () => ({
      entries,
      addFiles,
      cancel: (id) => {
        if (id.startsWith('rejected-')) setRejected((prev) => prev.filter((e) => e.id !== id));
        else uppy.removeFile(id);
      },
      retry: (id) => void uppy.retryUpload(id),
      clearFinished: () => {
        setRejected([]);
        for (const file of uppy.getFiles()) {
          if (file.progress.uploadComplete) uppy.removeFile(file.id);
        }
      },
    }),
    [entries, addFiles, uppy],
  );

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}
