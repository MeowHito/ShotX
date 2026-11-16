'use client';

import { ADMIN_ROUTES, type FinanceBucket } from '@shotx/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

export interface FinanceRangeQuery {
  from: string;
  to: string;
  bucket: FinanceBucket;
}

export const financeKeys = {
  all: ['admin-finance'] as const,
  summary: (range: FinanceRangeQuery) => ['admin-finance', 'summary', range] as const,
  expenses: (range: { from: string; to: string }) => ['admin-finance', 'expenses', range] as const,
  user: (id: string) => ['admin-finance', 'user', id] as const,
};

/**
 * GET /admin/finance (ADR 0027 §3): rollups only (orders, cash payments, expenses and the cost
 * estimate; never activity_events). The previous range stays on screen while the next loads.
 */
export function useFinance(range: FinanceRangeQuery | null) {
  const api = useApiClient();
  return useQuery({
    queryKey: financeKeys.summary(range ?? { from: '', to: '', bucket: 'day' }),
    queryFn: ({ signal }) => api.call(ADMIN_ROUTES.finance, { query: range ?? {}, signal }),
    enabled: range !== null,
    placeholderData: keepPreviousData,
  });
}

/** GET /admin/expenses for the page's range (spent_on DESC, cursor pagination). */
export function useExpenses(range: { from: string; to: string } | null) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: financeKeys.expenses(range ?? { from: '', to: '' }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(ADMIN_ROUTES.listExpenses, {
        query: {
          ...(range ?? {}),
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: range !== null,
  });
}

/** GET /admin/users/:id/finance (ADR 0027 §4), photographers only. */
export function useUserFinance(id: string, enabled: boolean) {
  const api = useApiClient();
  return useQuery({
    queryKey: financeKeys.user(id),
    queryFn: ({ signal }) => api.call(ADMIN_ROUTES.userFinance, { params: { id }, signal }),
    enabled,
  });
}
