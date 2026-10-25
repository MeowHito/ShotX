'use client';

import {
  type CreateShareBody,
  DRIVE_ROUTES,
  type ListSharesQuery,
  ME_ROUTES,
  SHARE_ROUTES,
  type ShareStatsQuery,
  type UpdateFaceIndexBody,
  type UpdateShareBody,
} from '@shotx/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';
import { driveKeys } from '@/lib/drive/queries';

export const studioKeys = {
  me: ['me'] as const,
  shares: ['shares'] as const,
  shareList: (filter: Pick<ListSharesQuery, 'fileId' | 'folderId'>) =>
    ['shares', 'list', filter] as const,
  share: (id: string) => ['shares', 'one', id] as const,
  stats: (id: string, range: ShareStatsQuery) => ['shares', 'stats', id, range] as const,
};

/** GET /me through the BFF (provisions the user on first use). */
export function useMe() {
  const api = useApiClient();
  return useQuery({
    queryKey: studioKeys.me,
    queryFn: ({ signal }) => api.call(ME_ROUTES.get, { signal }),
    staleTime: 5 * 60_000,
  });
}

/** POST /me/photographer: role photographer plus the trial (idempotent). */
export function useBecomePhotographer() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string | undefined) =>
      api.call(ME_ROUTES.becomePhotographer, { body: name ? { name } : {} }),
    onSuccess: (me) => queryClient.setQueryData(studioKeys.me, me),
  });
}

/** The caller's shares, newest first, optionally of one file or folder. */
export function useShares(filter: Pick<ListSharesQuery, 'fileId' | 'folderId'> = {}) {
  const api = useApiClient();
  const query = useInfiniteQuery({
    queryKey: studioKeys.shareList(filter),
    queryFn: ({ pageParam, signal }) =>
      api.call(SHARE_ROUTES.list, {
        query: { ...filter, ...(pageParam === null ? {} : { cursor: pageParam }) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  return { ...query, items: query.data?.pages.flatMap((p) => p.items) ?? [] };
}

export function useShare(id: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: studioKeys.share(id),
    queryFn: ({ signal }) => api.call(SHARE_ROUTES.get, { params: { id }, signal }),
  });
}

export function useShareStats(id: string, range: ShareStatsQuery) {
  const api = useApiClient();
  return useQuery({
    queryKey: studioKeys.stats(id, range),
    queryFn: ({ signal }) => api.call(SHARE_ROUTES.stats, { params: { id }, query: range, signal }),
  });
}

function useInvalidateShares() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: studioKeys.shares });
}

export function useCreateShare() {
  const api = useApiClient();
  const invalidate = useInvalidateShares();
  return useMutation({
    mutationFn: (body: CreateShareBody) => api.call(SHARE_ROUTES.create, { body }),
    onSuccess: invalidate,
  });
}

export function useUpdateShare() {
  const api = useApiClient();
  const invalidate = useInvalidateShares();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateShareBody }) =>
      api.call(SHARE_ROUTES.update, { params: { id }, body }),
    onSuccess: invalidate,
  });
}

export function useRevokeShare() {
  const api = useApiClient();
  const invalidate = useInvalidateShares();
  return useMutation({
    mutationFn: (id: string) => api.call(SHARE_ROUTES.revoke, { params: { id } }),
    onSuccess: invalidate,
  });
}

/** PATCH /drive/folders/:id/face-index. */
export function useUpdateFaceIndex() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateFaceIndexBody }) =>
      api.call(DRIVE_ROUTES.updateFaceIndex, { params: { id }, body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: driveKeys.all }),
  });
}

/** The owner's own download: a signed URL for the original. */
export function useOwnerDownload() {
  const api = useApiClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api.call(DRIVE_ROUTES.downloadFile, { params: { id: fileId }, query: { size: 'original' } }),
  });
}
