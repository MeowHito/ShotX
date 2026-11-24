'use client';

import { PACKAGE_ROUTES } from '@shotx/shared';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

export const packageKeys = {
  /** GET /me/package: the signed-in photographer's package (null: unlimited). */
  mine: ['package', 'mine'] as const,
  /** GET /me/package/offers: plans and add-ons the account can buy (ADR 0032). */
  offers: ['package', 'offers'] as const,
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

/** ADR 0032: what the signed-in photographer can buy in the studio (renewal and add-ons). */
export function usePackageOffers() {
  const api = useApiClient();
  return useQuery({
    queryKey: packageKeys.offers,
    queryFn: ({ signal }) => api.call(PACKAGE_ROUTES.offers, { signal }),
    staleTime: 60_000,
  });
}
