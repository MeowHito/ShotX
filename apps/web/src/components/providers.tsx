'use client';

import { ErrorCode } from '@shotx/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { type ApiClient, createApiClient } from '@/lib/api/client';
import { ApiError, isApiError } from '@/lib/api/errors';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { changePasswordPageHref } from '@/lib/auth/password-client';
import { BFF_PREFIX } from '@/lib/bff/constants';
import { navigateTo } from '@/lib/browser/navigate';

const ApiClientContext = createContext<ApiClient | null>(null);

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error('useApiClient outside <Providers>');
  return client;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // 4xx answers won't change on retry.
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

/**
 * The default reaction to PASSWORD_CHANGE_REQUIRED (ADR 0010): the session is restricted to the
 * password change, so go to that page and come back here afterwards. Never from that page itself.
 */
export function goToPasswordChange(): void {
  const { pathname, search } = window.location;
  if (pathname === AUTH_PATHS.changePasswordPage) return;
  navigateTo(changePasswordPageHref(`${pathname}${search}`));
}

/**
 * Watches every query and mutation of `client` for PASSWORD_CHANGE_REQUIRED and calls `onRequired`
 * once: whichever call finds out first that the session must change its temporary password.
 */
function usePasswordChangeWatcher(client: QueryClient, onRequired: () => void) {
  const fired = useRef(false);
  const latest = useRef(onRequired);
  useEffect(() => {
    latest.current = onRequired;
  });
  useEffect(() => {
    const check = (error: unknown) => {
      if (fired.current || !isApiError(error, ErrorCode.PASSWORD_CHANGE_REQUIRED)) return;
      fired.current = true;
      latest.current();
    };
    const queries = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') check(event.action.error);
    });
    const mutations = client.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') check(event.action.error);
    });
    return () => {
      queries();
      mutations();
    };
  }, [client]);
}

export function Providers({
  children,
  apiClient,
  queryClient,
  onPasswordChangeRequired = goToPasswordChange,
}: {
  children: ReactNode;
  apiClient?: ApiClient;
  queryClient?: QueryClient;
  /** What to do when a call answers PASSWORD_CHANGE_REQUIRED (default: the change page). */
  onPasswordChangeRequired?: () => void;
}) {
  const [api] = useState(() => apiClient ?? createApiClient({ baseUrl: BFF_PREFIX }));
  const [query] = useState(() => queryClient ?? createQueryClient());
  usePasswordChangeWatcher(query, onPasswordChangeRequired);
  return (
    <QueryClientProvider client={query}>
      <ApiClientContext.Provider value={api}>{children}</ApiClientContext.Provider>
    </QueryClientProvider>
  );
}
