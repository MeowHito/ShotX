'use client';

import { PACKAGE_ROUTES } from '@shotx/shared';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

export const packageKeys = {
  /** GET /me/package: the signed-in photographer's package (null: unlimited). */
  mine: ['package', 'mine'] as const,
};

/**
 * The signed-in photographer's package through the BFF (ADR 0026): `null` for an unlimited
 * (admin-created) account. Refreshed after uploads (each accepted file counts one photo).
 */
export function useMyPackage() {
  const api = useApiClient();
  return useQuery({
    queryKey: packageKeys.mine,
    queryFn: ({ signal }) => api.call(PACKAGE_ROUTES.myPackage, { signal }),
    staleTime: 60_000,
  });
}
