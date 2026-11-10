'use client';

import { ErrorCode } from '@shotx/shared';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { type ApiClient, createApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { BFF_PREFIX } from '@/lib/bff/constants';
import { SIGN_IN_PATHS } from '@/lib/sign-in/protocol';

const ApiClientContext = createContext<ApiClient | null>(null);
const SessionEndedContext = createContext<(error: unknown) => boolean>(() => false);

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error('useApiClient outside <Providers>');
  return client;
}

/** Answers after which the session is over (the BFF has already cleared the cookies). */
const SESSION_ENDED: readonly ErrorCode[] = [
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.MFA_REQUIRED,
  ErrorCode.ACCOUNT_DISABLED,
];

export function isSessionEnded(error: unknown): boolean {
  return error instanceof ApiError && SESSION_ENDED.includes(error.code);
}

/**
 * For API calls made outside TanStack Query (the create and reset-password dialogs, which keep the
 * password out of the mutation cache): `(error) => true` when the error ended the session, after
 * sending the browser to the sign-in page.
 */
export function useSessionEndedHandler(): (error: unknown) => boolean {
  return useContext(SessionEndedContext);
}

function goToSignIn() {
  const next = window.location.pathname;
  window.location.assign(
    `${SIGN_IN_PATHS.loginPage}?error=session&next=${encodeURIComponent(next)}`,
  );
}

export function createQueryClient(onSessionEnded: () => void = goToSignIn): QueryClient {
  const onError = (error: unknown) => {
    if (isSessionEnded(error)) onSessionEnded();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // 4xx answers won't change on retry.
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
      // Mutations are never retried automatically: each one is an audited admin action.
      mutations: { retry: false },
    },
  });
}

export function Providers({
  children,
  apiClient,
  queryClient,
  onSessionEnded = goToSignIn,
}: {
  children: ReactNode;
  apiClient?: ApiClient;
  queryClient?: QueryClient;
  /** Tests pass a spy instead of navigating. */
  onSessionEnded?: () => void;
}) {
  const [api] = useState(() => apiClient ?? createApiClient({ baseUrl: BFF_PREFIX }));
  const [query] = useState(() => queryClient ?? createQueryClient(onSessionEnded));
  const [sessionEnded] = useState(() => (error: unknown) => {
    if (!isSessionEnded(error)) return false;
    onSessionEnded();
    return true;
  });
  return (
    <QueryClientProvider client={query}>
      <ApiClientContext.Provider value={api}>
        <SessionEndedContext.Provider value={sessionEnded}>{children}</SessionEndedContext.Provider>
      </ApiClientContext.Provider>
    </QueryClientProvider>
  );
}
