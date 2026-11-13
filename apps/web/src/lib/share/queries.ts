'use client';

import {
  CAPTCHA_TOKEN_HEADER,
  type ConsentPolicyVersion,
  type ConsentPurpose,
  type FaceDeletionInfoResponse,
  PUBLIC_SHARE_ROUTES,
  SELFIE_FIELD_NAME,
  type ShareItem,
  type ShareItemsResponse,
  type ShareMetaResponse,
  type SupportedLocale,
} from '@shotx/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useShareApi } from './share-api';

/**
 * Query keys. A page shows one share: its meta is keyed by the ref of the URL (a slug or an old
 * token, ADR 0011), everything else by `meta.token`, with which every further call is made.
 */
export const shareKeys = {
  /** Every query of the page's share, whatever ref it is keyed by. */
  page: ['share'] as const,
  all: (token: string) => ['share', token] as const,
  meta: (token: string) => ['share', token, 'meta'] as const,
  items: (token: string) => ['share', token, 'items'] as const,
  faceDeletion: (token: string) => ['share', token, 'face-deletion'] as const,
};

/**
 * Share meta as this browser sees it, by the page's ref (slug or token). The SSR copy (fetched
 * without the viewer's /api cookies) is only a placeholder: access flags and consent come from the
 * client fetch.
 */
export function useShareMeta(ref: string, initial: ShareMetaResponse | null) {
  const { api } = useShareApi();
  return useQuery({
    queryKey: shareKeys.meta(ref),
    queryFn: ({ signal }) => api.call(PUBLIC_SHARE_ROUTES.meta, { params: { token: ref }, signal }),
    placeholderData: initial ?? undefined,
    staleTime: 60_000,
  });
}

/** Refetch this long before signed URLs expire. */
const URL_REFRESH_MARGIN_MS = 60_000;

/** The share's items, page by page (cursor pagination), refreshed before their URLs expire. */
export function useShareItems(token: string, enabled: boolean) {
  const { api } = useShareApi();
  const query = useInfiniteQuery({
    queryKey: shareKeys.items(token),
    queryFn: ({ pageParam, signal }) =>
      api.call(PUBLIC_SHARE_ROUTES.items, {
        params: { token },
        query: pageParam === null ? {} : { cursor: pageParam },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ShareItemsResponse) => last.nextCursor,
    enabled,
  });
  const items: ShareItem[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const firstExpiry = items.reduce(
    (min, i) => Math.min(min, Date.parse(i.urlsExpireAt)),
    Number.POSITIVE_INFINITY,
  );
  const { refetch } = query;
  useEffect(() => {
    if (!Number.isFinite(firstExpiry)) return;
    const delay = Math.max(0, firstExpiry - URL_REFRESH_MARGIN_MS - Date.now());
    // Timers beyond ~24.8 days overflow; such URLs never need a refresh in one visit.
    if (delay > 2 ** 31 - 1) return;
    const timer = setTimeout(() => void refetch(), delay);
    return () => clearTimeout(timer);
  }, [firstExpiry, refetch]);
  return { ...query, items };
}

/**
 * ADR 0020: keeps an open share page current without a reload. Every `intervalMs` (while the tab
 * is visible) it asks GET /s/:token/changes; when the version moves it refetches the page's meta
 * and items in the background. Nothing is shown while it works: the old photos stay until the
 * new list arrives, newest first, so new photos simply appear at the top.
 */
export function useShareLiveUpdates(token: string, intervalMs: number) {
  const { api } = useShareApi();
  const queryClient = useQueryClient();
  const changes = useQuery({
    // Not under shareKeys.page: refetching the page must not re-trigger this check.
    queryKey: ['share-changes', token],
    queryFn: ({ signal }) => api.call(PUBLIC_SHARE_ROUTES.changes, { params: { token }, signal }),
    enabled: intervalMs > 0,
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
  const version = changes.data?.version;
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (version === undefined) return;
    if (seen.current !== undefined && seen.current !== version) {
      void queryClient.invalidateQueries({ queryKey: shareKeys.page });
    }
    seen.current = version;
  }, [version, queryClient]);
}

/** Refetches the page's share (meta by its ref, items by token); `token` is kept for callers. */
export function useInvalidateShare(_token?: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: shareKeys.page });
}

export function useUnlockShare(token: string) {
  const { api } = useShareApi();
  const invalidate = useInvalidateShare(token);
  return useMutation({
    mutationFn: (password: string) =>
      api.call(PUBLIC_SHARE_ROUTES.unlock, { params: { token }, body: { password } }),
    onSuccess: invalidate,
  });
}

/**
 * What "delete my face" needs (GET /s/:token/face-deletion). Token lookup only: it answers on
 * expired and revoked shares and with face search switched off.
 */
export function useFaceDeletionInfo(token: string) {
  const { api } = useShareApi();
  return useQuery({
    queryKey: shareKeys.faceDeletion(token),
    queryFn: ({ signal }) =>
      api.call(PUBLIC_SHARE_ROUTES.faceDeletionInfo, { params: { token }, signal }),
    staleTime: 60_000,
  });
}

/** Accepts the consent text of `purpose` in `policyVersion` for this share. */
/** Consent, recording the language the text was shown in (ADR 0011). */
export function useGiveConsent(token: string, purpose: ConsentPurpose, locale: SupportedLocale) {
  const { api } = useShareApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policyVersion: ConsentPolicyVersion) =>
      api.call(PUBLIC_SHARE_ROUTES.giveConsent, {
        params: { token },
        body: { purpose, policyVersion, locale, accepted: true },
      }),
    onSuccess: () => {
      if (purpose === 'face_deletion') {
        queryClient.setQueryData<FaceDeletionInfoResponse>(shareKeys.faceDeletion(token), (info) =>
          info === undefined ? info : { ...info, consented: true },
        );
        return queryClient.invalidateQueries({ queryKey: shareKeys.faceDeletion(token) });
      }
      // The meta is keyed by the page's ref, which may be the slug.
      const isMeta = {
        predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[2] === 'meta',
      };
      queryClient.setQueriesData<ShareMetaResponse>(isMeta, (meta) =>
        meta === undefined
          ? meta
          : { ...meta, faceSearch: { ...meta.faceSearch, consented: true } },
      );
      return queryClient.invalidateQueries(isMeta);
    },
  });
}

/** The multipart body of face search and face deletion: one `selfie` part per photo. */
export function selfieForm(selfies: readonly Blob[]): FormData {
  const form = new FormData();
  selfies.forEach((blob, i) => form.append(SELFIE_FIELD_NAME, blob, `selfie-${i + 1}.jpg`));
  return form;
}

/**
 * The selfies of one face search or face deletion (in memory only), and the Turnstile token when
 * the API asked for a challenge (RATE_LIMITED with `details.captcha`). The token travels in
 * CAPTCHA_TOKEN_HEADER so the API decides before it reads any selfie.
 */
export interface SelfieRequest {
  selfies: readonly Blob[];
  captchaToken?: string;
}

function captchaHeaders(captchaToken: string | undefined) {
  return captchaToken === undefined ? undefined : { [CAPTCHA_TOKEN_HEADER]: captchaToken };
}

export function useFaceSearch(token: string) {
  const { api } = useShareApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ selfies, captchaToken }: SelfieRequest) =>
      api.call(PUBLIC_SHARE_ROUTES.faceSearch, {
        params: { token },
        form: selfieForm(selfies),
        headers: captchaHeaders(captchaToken),
      }),
    // face_only items come from the new result.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shareKeys.items(token) }),
  });
}

export function useFaceDeletion(token: string) {
  const { api } = useShareApi();
  return useMutation({
    mutationFn: ({ selfies, captchaToken }: SelfieRequest) =>
      api.call(PUBLIC_SHARE_ROUTES.faceDeletion, {
        params: { token },
        form: selfieForm(selfies),
        headers: captchaHeaders(captchaToken),
      }),
  });
}
