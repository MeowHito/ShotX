'use client';

import { ADMIN_ROUTES } from '@shotx/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

export const cashKeys = {
  all: ['admin-cash-payments'] as const,
  byPhotographer: (photographerId: string) =>
    ['admin-cash-payments', 'photographer', photographerId] as const,
};

/** GET /admin/cash-payments?photographerId=… (paid_at DESC, cursor pagination). */
export function useCashPayments(photographerId: string) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: cashKeys.byPhotographer(photographerId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(ADMIN_ROUTES.listCashPayments, {
        query: { photographerId, ...(pageParam !== undefined ? { cursor: pageParam } : {}) },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
