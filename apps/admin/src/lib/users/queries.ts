'use client';

import {
  ADMIN_ROUTES,
  type AccountRole,
  type AccountStatus,
  type AdminUser,
  type ListAdminUsersQuery,
} from '@shotx/shared';
import { type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

export interface UserFilters {
  q?: string;
  role?: AccountRole;
  status?: AccountStatus;
}

export const userKeys = {
  all: ['admin-users'] as const,
  list: (filters: UserFilters) => ['admin-users', 'list', filters] as const,
  detail: (id: string) => ['admin-users', 'detail', id] as const,
};

/** GET /admin/users with cursor pagination (newest first). A cursor is tied to its filters. */
export function useUsersList(filters: UserFilters) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: userKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const query: ListAdminUsersQuery = {
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.role ? { role: filters.role } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
      };
      return api.call(ADMIN_ROUTES.listUsers, { query, signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** GET /admin/users/:id. */
export function useUser(id: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: userKeys.detail(id),
    queryFn: ({ signal }) => api.call(ADMIN_ROUTES.getUser, { params: { id }, signal }),
  });
}

/**
 * After a mutation answered with the updated user: put it in the detail cache and refetch the
 * lists (status filters may now exclude it).
 */
export function applyUserUpdate(queryClient: QueryClient, user: AdminUser): Promise<void> {
  queryClient.setQueryData(userKeys.detail(user.id), user);
  return queryClient.invalidateQueries({ queryKey: [...userKeys.all, 'list'] });
}
