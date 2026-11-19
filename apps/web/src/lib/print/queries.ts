'use client';

import {
  type ListPrintOrdersResponse,
  PRINT_ROUTES,
  type PrintOrderStatus,
  type UpdatePrintSettingsBody,
} from '@shotx/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/components/providers';

/** How often the studio's print page looks for new orders (ADR 0031). */
export const PRINT_ORDERS_POLL_MS = 5_000;

export const printKeys = {
  all: ['print'] as const,
  settings: ['print', 'settings'] as const,
  orders: (status?: PrintOrderStatus) =>
    status === undefined ? (['print', 'orders'] as const) : (['print', 'orders', status] as const),
};

export function usePrintSettings() {
  const api = useApiClient();
  return useQuery({
    queryKey: printKeys.settings,
    queryFn: ({ signal }) => api.call(PRINT_ROUTES.getSettings, { signal }),
  });
}

export function useUpdatePrintSettings() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePrintSettingsBody) => api.call(PRINT_ROUTES.updateSettings, { body }),
    onSuccess: (settings) => queryClient.setQueryData(printKeys.settings, settings),
  });
}

/** One status's orders (newest first) and the counts of all, polled while the page is open. */
export function usePrintOrders(status: PrintOrderStatus, enabled = true) {
  const api = useApiClient();
  return useQuery<ListPrintOrdersResponse>({
    queryKey: printKeys.orders(status),
    queryFn: ({ signal }) => api.call(PRINT_ROUTES.listOrders, { query: { status }, signal }),
    enabled,
    refetchInterval: PRINT_ORDERS_POLL_MS,
    refetchIntervalInBackground: true,
  });
}

/** Approve, reject or print one order; every list refreshes after. */
export function usePrintOrderAction() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      onlyQueued = false,
    }: {
      id: string;
      action: 'approve' | 'reject' | 'print';
      onlyQueued?: boolean;
    }) => {
      if (action === 'approve') return api.call(PRINT_ROUTES.approveOrder, { params: { id } });
      if (action === 'reject') return api.call(PRINT_ROUTES.rejectOrder, { params: { id } });
      return api.call(PRINT_ROUTES.printOrder, { params: { id }, body: { onlyQueued } });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: printKeys.orders() }),
  });
}
