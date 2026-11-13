'use client';

import {
  type CreateDesignBody,
  DESIGN_ROUTES,
  type Design,
  type DesignAssetMap,
  type ListDesignsResponse,
} from '@shotx/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

/** TanStack Query hooks of the design routes (ADR 0013), through the BFF. */

export const designKeys = {
  all: ['designs'] as const,
  list: ['designs', 'list'] as const,
  one: (id: string) => ['designs', 'one', id] as const,
  assets: ['designs', 'assets'] as const,
};

/** GET /designs: every design with its document (mini previews), one asset map, the limits. */
export function useDesigns(enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: designKeys.list,
    queryFn: ({ signal }) => api.call(DESIGN_ROUTES.list, { signal }),
    enabled,
  });
}

/** GET /designs/:id: the editor's design (never refetched behind its back). */
export function useDesign(id: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: designKeys.one(id),
    queryFn: ({ signal }) => api.call(DESIGN_ROUTES.get, { params: { id }, signal }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/** How often the uploads list refreshes while one of its images is still being prepared. */
export const DESIGN_ASSETS_PENDING_REFETCH_MS = 3000;

/**
 * GET /designs/assets: the caller's images (first page), newest first. Refetched every
 * DESIGN_ASSETS_PENDING_REFETCH_MS while any of them is still uploading or processing, so a
 * slow one appears as soon as the worker has made it.
 */
export function useDesignAssets(enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: designKeys.assets,
    queryFn: ({ signal }) => api.call(DESIGN_ROUTES.listAssets, { query: {}, signal }),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.items.some((a) => a.status === 'uploading' || a.status === 'processing')
        ? DESIGN_ASSETS_PENDING_REFETCH_MS
        : false,
  });
}

function useInvalidateList() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: designKeys.list });
}

export function useCreateDesign() {
  const api = useApiClient();
  const invalidate = useInvalidateList();
  return useMutation({
    mutationFn: (body: CreateDesignBody) => api.call(DESIGN_ROUTES.create, { body }),
    onSuccess: () => invalidate(),
  });
}

/** PUT /designs/:id (rename from the list; the editor saves through its autosave). */
export function useSaveDesign() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (design: Pick<Design, 'id' | 'name' | 'doc' | 'revision'>) =>
      api.call(DESIGN_ROUTES.update, {
        params: { id: design.id },
        body: { name: design.name, doc: design.doc, revision: design.revision },
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(designKeys.one(saved.id), saved);
      return queryClient.invalidateQueries({ queryKey: designKeys.list });
    },
  });
}

export function useDeleteDesign() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.call(DESIGN_ROUTES.delete, { params: { id } }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<ListDesignsResponse>(designKeys.list, (prev) =>
        prev === undefined ? prev : { ...prev, items: prev.items.filter((d) => d.id !== id) },
      );
      queryClient.removeQueries({ queryKey: designKeys.one(id) });
      // Share settings may have pointed at it (their designId is null now).
      void queryClient.invalidateQueries({ queryKey: ['shares'] });
      return queryClient.invalidateQueries({ queryKey: designKeys.list });
    },
  });
}

/** POST or DELETE /designs/:id/default. */
export function useSetDefaultDesign() {
  const api = useApiClient();
  const invalidate = useInvalidateList();
  return useMutation({
    mutationFn: ({ id, isDefault }: { id: string; isDefault: boolean }) =>
      isDefault
        ? api.call(DESIGN_ROUTES.setDefault, { params: { id } })
        : api.call(DESIGN_ROUTES.clearDefault, { params: { id } }),
    onSuccess: () => invalidate(),
  });
}

/** The image URLs of an asset map, for the renderer (null: not ready, draw nothing). */
export function assetUrls(map: DesignAssetMap): Record<string, string | null> {
  return Object.fromEntries(Object.entries(map).map(([id, a]) => [id, a.url]));
}
