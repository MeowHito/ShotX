'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { type ApiClient, createApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { BFF_PREFIX } from '@/lib/bff/constants';

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

export function Providers({
  children,
  apiClient,
  queryClient,
}: {
  children: ReactNode;
  apiClient?: ApiClient;
  queryClient?: QueryClient;
}) {
  const [api] = useState(() => apiClient ?? createApiClient({ baseUrl: BFF_PREFIX }));
  const [query] = useState(() => queryClient ?? createQueryClient());
  return (
    <QueryClientProvider client={query}>
      <ApiClientContext.Provider value={api}>{children}</ApiClientContext.Provider>
    </QueryClientProvider>
  );
}
