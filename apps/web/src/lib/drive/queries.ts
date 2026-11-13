'use client';

import {
  DRIVE_ROUTES,
  type DriveFile,
  type DriveItem,
  type DriveItemRef,
  type FolderRef,
  IDEMPOTENCY_KEY_HEADER,
  type ListChildrenResponse,
  type SearchDriveQuery,
  type TrashItem,
  type ZipJobView,
} from '@shotx/shared';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

export const driveKeys = {
  all: ['drive'] as const,
  children: (ref: FolderRef) => ['drive', 'children', ref] as const,
  trash: ['drive', 'trash'] as const,
  usage: ['drive', 'usage'] as const,
  recent: ['drive', 'recent'] as const,
  stats: (days: number) => ['drive', 'stats', days] as const,
  search: (query: SearchDriveQuery | null) => ['drive', 'search', query] as const,
  file: (id: string) => ['drive', 'file', id] as const,
  folderSummary: (id: string) => ['drive', 'folder-summary', id] as const,
};

/** Still being made (an upload or a copy the worker is finishing): worth refreshing. */
export function isPendingItem(item: DriveItem): boolean {
  return item.kind === 'file' && (item.status === 'processing' || item.status === 'uploading');
}

/** A refetch interval that runs only while a page shows a pending item. */
function whilePending<P>(pollMs: number | undefined, itemsOf: (page: P) => DriveItem[]) {
  return (query: { state: { data?: { pages: P[] } } }) =>
    pollMs !== undefined &&
    (query.state.data?.pages ?? []).some((p) => itemsOf(p).some(isPendingItem))
      ? pollMs
      : false;
}

/** Calls once more when the first call got no response; safe with an idempotency id or key. */
async function retryLostResponse<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && error.name === 'NetworkError') return call();
    throw error;
  }
}

/**
 * A folder's children, page by page (cursor pagination; folders first). With `processingPollMs`
 * the listing refreshes while it shows a file still processing (an upload or a copy).
 */
export function useFolderChildren(ref: FolderRef, options: { processingPollMs?: number } = {}) {
  const api = useApiClient();
  const query = useInfiniteQuery({
    queryKey: driveKeys.children(ref),
    refetchInterval: whilePending<ListChildrenResponse>(options.processingPollMs, (p) => p.items),
    queryFn: ({ pageParam, signal }) =>
      api.call(DRIVE_ROUTES.listChildren, {
        params: { id: ref },
        query: pageParam === null ? {} : { cursor: pageParam },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ListChildrenResponse) => last.nextCursor,
  });
  const first = query.data?.pages[0];
  const items: DriveItem[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...query, items, folder: first?.folder ?? null, ancestors: first?.ancestors ?? [] };
}

/** The trash listing, page by page. */
export function useTrash() {
  const api = useApiClient();
  const query = useInfiniteQuery({
    queryKey: driveKeys.trash,
    queryFn: ({ pageParam, signal }) =>
      api.call(DRIVE_ROUTES.listTrash, {
        query: pageParam === null ? {} : { cursor: pageParam },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items: TrashItem[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...query, items };
}

export function useDriveUsage() {
  const api = useApiClient();
  return useQuery({
    queryKey: driveKeys.usage,
    queryFn: ({ signal }) => api.call(DRIVE_ROUTES.usage, { signal }),
  });
}

/** Invalidate every drive query (listings, trash and usage) after a change. */
export function useInvalidateDrive() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: driveKeys.all });
}

export function useCreateFolder() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: (input: { parentId: string | null; name: string }) =>
      api.call(DRIVE_ROUTES.createFolder, { body: input }),
    onSuccess: invalidate,
  });
}

export function useRenameItem() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: ({ item, name }: { item: DriveItemRef; name: string }): Promise<DriveItem> =>
      item.kind === 'folder'
        ? api.call(DRIVE_ROUTES.updateFolder, { params: { id: item.id }, body: { name } })
        : api.call(DRIVE_ROUTES.updateFile, { params: { id: item.id }, body: { name } }),
    onSuccess: invalidate,
  });
}

export interface RenameFilesResult {
  renamed: number;
  failures: { id: string; error: unknown }[];
}

/**
 * ADR 0023: renames files one PATCH each, in the order of `steps` (renameSteps: temporary names
 * first when the batch swaps names). A file whose step fails is reported and skipped after that.
 */
export function useRenameFiles() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: async ({
      steps,
      onProgress,
    }: {
      steps: readonly { id: string; name: string; final: boolean }[];
      onProgress?: (done: number, total: number) => void;
    }): Promise<RenameFilesResult> => {
      const failed = new Map<string, unknown>();
      const total = steps.filter((s) => s.final).length;
      let renamed = 0;
      for (const step of steps) {
        if (failed.has(step.id)) continue;
        try {
          await api.call(DRIVE_ROUTES.updateFile, {
            params: { id: step.id },
            body: { name: step.name },
          });
          if (step.final) {
            renamed += 1;
            onProgress?.(renamed, total);
          }
        } catch (error) {
          failed.set(step.id, error);
        }
      }
      return { renamed, failures: [...failed].map(([id, error]) => ({ id, error })) };
    },
    onSettled: invalidate,
  });
}

/**
 * The folder's share-page cover (ADR 0011): a photo of the folder, or null for the default (the
 * first photo). COVER_FILE_INVALID when the photo can't be one (videos, not ready, trashed).
 */
export function useSetFolderCover() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: ({ folderId, fileId }: { folderId: string; fileId: string | null }) =>
      api.call(DRIVE_ROUTES.updateFolder, {
        params: { id: folderId },
        body: { coverFileId: fileId },
      }),
    onSuccess: invalidate,
  });
}

export interface MoveResult {
  moved: number;
  failures: { item: DriveItemRef; error: unknown }[];
}

/** Moves items one PATCH each (the API has no batch move); reports the ones that failed. */
export function useMoveItems() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: async ({
      items,
      targetId,
    }: {
      items: DriveItemRef[];
      targetId: string | null;
    }): Promise<MoveResult> => {
      const results = await Promise.allSettled(
        items.map((item) =>
          item.kind === 'folder'
            ? api.call(DRIVE_ROUTES.updateFolder, {
                params: { id: item.id },
                body: { parentId: targetId },
              })
            : api.call(DRIVE_ROUTES.updateFile, {
                params: { id: item.id },
                body: { folderId: targetId },
              }),
        ),
      );
      const failures = results.flatMap((r, i) =>
        r.status === 'rejected'
          ? [{ item: items[i] as DriveItemRef, error: r.reason as unknown }]
          : [],
      );
      return { moved: items.length - failures.length, failures };
    },
    onSettled: invalidate,
  });
}

export function useTrashItems() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: (items: DriveItemRef[]) => api.call(DRIVE_ROUTES.trashItems, { body: { items } }),
    onSuccess: invalidate,
  });
}

export function useRestoreItems() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: (items: DriveItemRef[]) => api.call(DRIVE_ROUTES.restoreItems, { body: { items } }),
    onSuccess: invalidate,
  });
}

export function useEmptyTrash() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: () => api.call(DRIVE_ROUTES.emptyTrash),
    onSuccess: invalidate,
  });
}

export interface CopyResult {
  copies: DriveFile[];
  failures: { file: DriveFile; error: unknown }[];
}

/**
 * Copy (itemMenu.copy) of files into a folder (null: the root), one POST each. Each file of one copy action
 * gets its own `clientCopyId`, kept when a lost response is retried, so a retry never makes a
 * second copy; a new paste is a new action with new ids. Names that are taken become "name (2)".
 */
export function useCopyFiles() {
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  return useMutation({
    mutationFn: async ({
      files,
      targetFolderId,
    }: {
      files: readonly DriveFile[];
      targetFolderId: string | null;
    }): Promise<CopyResult> => {
      const results = await Promise.allSettled(
        files.map((file) => {
          const clientCopyId = crypto.randomUUID();
          return retryLostResponse(() =>
            api.call(DRIVE_ROUTES.copyFile, {
              params: { id: file.id },
              body: { targetFolderId, onNameConflict: 'rename', clientCopyId },
            }),
          );
        }),
      );
      const copies: DriveFile[] = [];
      const failures: CopyResult['failures'] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') copies.push(r.value);
        else failures.push({ file: files[i] as DriveFile, error: r.reason as unknown });
      });
      return { copies, failures };
    },
    onSettled: invalidate,
  });
}

/** Starts the owner's ZIP of a folder (originals); poll the job with pollOwnerZipJob. */
export function useDownloadFolder() {
  const api = useApiClient();
  return useMutation({
    mutationFn: async ({
      folderId,
      idempotencyKey,
    }: {
      folderId: string;
      idempotencyKey: string;
    }): Promise<ZipJobView> => {
      const res = await retryLostResponse(() =>
        api.call(DRIVE_ROUTES.downloadFolder, {
          params: { id: folderId },
          headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
          body: { size: 'original' },
        }),
      );
      return res.job;
    },
  });
}

/** Recent: the newest files, page by page; refreshes while one is processing. */
export function useRecent(options: { processingPollMs?: number } = {}) {
  const api = useApiClient();
  const query = useInfiniteQuery({
    queryKey: driveKeys.recent,
    queryFn: ({ pageParam, signal }) =>
      api.call(DRIVE_ROUTES.recent, {
        query: pageParam === null ? {} : { cursor: pageParam },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: whilePending<{ items: DriveFile[] }>(options.processingPollMs, (p) => p.items),
  });
  const items: DriveFile[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...query, items };
}

/** ADR 0023: GET /drive/stats, photos uploaded and downloaded per day. */
export function useDriveStats(days: number) {
  const api = useApiClient();
  return useQuery({
    queryKey: driveKeys.stats(days),
    queryFn: ({ signal }) => api.call(DRIVE_ROUTES.stats, { query: { days }, signal }),
    staleTime: 60_000,
  });
}

/** GET /drive/search, page by page; disabled while `query` is null (no criterion yet). */
export function useDriveSearch(query: SearchDriveQuery | null) {
  const api = useApiClient();
  const result = useInfiniteQuery({
    queryKey: driveKeys.search(query),
    enabled: query !== null,
    queryFn: ({ pageParam, signal }) =>
      api.call(DRIVE_ROUTES.search, {
        query: { ...query, ...(pageParam === null ? {} : { cursor: pageParam }) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const pages = result.data?.pages ?? [];
  return {
    ...result,
    results: pages.flatMap((p) => p.items),
    truncated: pages.some((p) => p.truncated),
  };
}

/** Item info (itemMenu.fileInfo) of a file (with its location) or a folder (with its summary); null: off. */
export function useItemInfo(item: { kind: 'file' | 'folder'; id: string } | null) {
  const api = useApiClient();
  const file = useQuery({
    queryKey: driveKeys.file(item?.id ?? ''),
    enabled: item?.kind === 'file',
    queryFn: ({ signal }) =>
      api.call(DRIVE_ROUTES.getFile, { params: { id: item?.id ?? '' }, signal }),
  });
  const folder = useQuery({
    queryKey: driveKeys.folderSummary(item?.id ?? ''),
    enabled: item?.kind === 'folder',
    queryFn: ({ signal }) =>
      api.call(DRIVE_ROUTES.folderSummary, { params: { id: item?.id ?? '' }, signal }),
  });
  return { file, folder };
}

/** Ref of an item for trash/restore/move bodies. */
export function itemRef(item: { kind: 'folder' | 'file'; id: string }): DriveItemRef {
  return { kind: item.kind, id: item.id };
}

export type ChildrenData = InfiniteData<ListChildrenResponse, string | null>;
