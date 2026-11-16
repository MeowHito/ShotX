'use client';

import { ADMIN_ROUTES, type ListAuditLogQuery } from '@shotx/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

export type AuditFilters = Omit<ListAuditLogQuery, 'cursor' | 'limit'>;

export const auditKeys = {
  all: ['admin-audit-log'] as const,
  list: (filters: AuditFilters) => ['admin-audit-log', 'list', filters] as const,
};

/** GET /admin/audit-log, newest first, cursor pagination. A cursor is tied to its filters. */
export function useAuditLog(filters: AuditFilters) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(ADMIN_ROUTES.auditLog, {
        query: { ...filters, ...(pageParam !== undefined ? { cursor: pageParam } : {}) },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
