'use client';

import {
  DRIVE_ROUTES,
  type DriveItem,
  type DriveItemRef,
  type FolderRef,
  type ListChildrenResponse,
  type TrashItem,
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
};

/** A folder's children, page by page (cursor pagination; folders first). */
export function useFolderChildren(ref: FolderRef) {
  const api = useApiClient();
  const query = useInfiniteQuery({
    queryKey: driveKeys.children(ref),
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

/** Ref of an item for trash/restore/move bodies. */
export function itemRef(item: { kind: 'folder' | 'file'; id: string }): DriveItemRef {
  return { kind: item.kind, id: item.id };
}

export type ChildrenData = InfiniteData<ListChildrenResponse, string | null>;
