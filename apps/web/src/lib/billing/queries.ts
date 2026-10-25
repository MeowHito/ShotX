'use client';

import {
  BILLING_ROUTES,
  type CheckoutChangeType,
  type CheckoutPaymentBody,
  type CheckoutResponse,
  type CurrentSubscription,
  classifyCheckout,
  IDEMPOTENCY_KEY_HEADER,
  type PaymentView,
  type PlansResponse,
  type PublicPlan,
  type SubscriptionView,
} from '@shotx/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { useApiClient } from '@/components/providers';
import { driveKeys } from '@/lib/drive/queries';
import { studioKeys } from '@/lib/studio/queries';
import { type ApiClient, createPublicApiClient } from '../api/client';

export const billingKeys = {
  all: ['billing'] as const,
  plans: ['billing', 'plans'] as const,
  subscription: ['billing', 'subscription'] as const,
  payment: (id: string) => ['billing', 'payment', id] as const,
};

/**
 * Client of the public routes (`GET /plans`) at `/api`. The BFF forwards photographer routes
 * only, so the price list is read like the share page reads its routes. Tests inject the fake.
 */
export const PublicApiContext = createContext<ApiClient | null>(null);

let defaultPublicApi: ApiClient | undefined;

export function usePublicApi(): ApiClient {
  const injected = useContext(PublicApiContext);
  if (injected !== null) return injected;
  defaultPublicApi ??= createPublicApiClient();
  return defaultPublicApi;
}

/** GET /plans: active plans with every price, VAT included (the client never computes prices). */
export function usePlans(initial?: PlansResponse) {
  const api = usePublicApi();
  return useQuery({
    queryKey: billingKeys.plans,
    queryFn: ({ signal }) => api.call(BILLING_ROUTES.plans, { signal }),
    initialData: initial,
    staleTime: 60_000,
  });
}

/** GET /billing/subscription through the BFF. */
export function useSubscription() {
  const api = useApiClient();
  return useQuery({
    queryKey: billingKeys.subscription,
    queryFn: ({ signal }) => api.call(BILLING_ROUTES.subscription, { signal }),
    staleTime: 30_000,
  });
}

/** After a change: the subscription, the usage bar (quota) and `me` are stale. */
export function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription }),
      queryClient.invalidateQueries({ queryKey: driveKeys.all }),
      queryClient.invalidateQueries({ queryKey: studioKeys.me }),
    ]);
}

/** POST /billing/subscription/cancel: auto-renew off at period end (idempotent). */
export function useCancelAutoRenew() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: () => api.call(BILLING_ROUTES.cancelSubscription),
    onSuccess: (data) => {
      queryClient.setQueryData(billingKeys.subscription, data);
      return invalidate();
    },
  });
}

export interface CheckoutRequest {
  planCode: string;
  changeType: CheckoutChangeType;
  payment: CheckoutPaymentBody;
  /** One per click: a retry after a lost response replays the same checkout. */
  idempotencyKey: string;
}

/** POST /billing/checkout with its Idempotency-Key. A lost response is retried once, same key. */
export function useCheckout() {
  const api = useApiClient();
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: async (request: CheckoutRequest): Promise<CheckoutResponse> => {
      const call = () =>
        api.call(BILLING_ROUTES.checkout, {
          headers: { [IDEMPOTENCY_KEY_HEADER]: request.idempotencyKey },
          body: {
            planCode: request.planCode,
            changeType: request.changeType,
            payment: request.payment,
          },
        });
      try {
        return await call();
      } catch (error) {
        if (error instanceof Error && error.name === 'NetworkError') return call();
        throw error;
      }
    },
    onSuccess: (res) => (res.status === 'completed' ? invalidate() : undefined),
  });
}

/** True once a payment needs no more polling. */
export function isPaymentFinal(payment: PaymentView): boolean {
  return (
    payment.status !== 'pending' ||
    (payment.checkout !== null && payment.checkout.status !== 'pending')
  );
}

/** GET /billing/payments/:id, polled every `intervalMs` until the payment is final. */
export function usePayment(id: string, intervalMs: number) {
  const api = useApiClient();
  return useQuery({
    queryKey: billingKeys.payment(id),
    queryFn: ({ signal }) => api.call(BILLING_ROUTES.payment, { params: { id }, signal }),
    refetchInterval: (query) =>
      query.state.data !== undefined && isPaymentFinal(query.state.data) ? false : intervalMs,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
}

/** The subscription in the shape of the shared classifier (plan id = plan code). */
function currentForClassifier(
  sub: SubscriptionView | null,
  plans: readonly PublicPlan[],
): CurrentSubscription | null {
  if (sub === null) return null;
  const plan = plans.find((p) => p.code === sub.plan.code);
  return {
    status: sub.status,
    planId: sub.plan.code,
    quotaBytes: sub.plan.quotaBytes,
    priceMonthSatang: plan?.month.totalSatang ?? 0,
    billing: sub.billing,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodStart: new Date(sub.periodStart),
    periodEnd: new Date(sub.periodEnd),
    pendingPlanId: sub.pendingChange?.plan.code ?? null,
  };
}

/**
 * The change a checkout of `plan` would be (classifyCheckout, the API's own rule). The client
 * declares it and the API refuses a mismatch, so nobody pays for a change they didn't see.
 */
export function changeTypeFor(
  sub: SubscriptionView | null,
  plans: readonly PublicPlan[],
  plan: PublicPlan,
): CheckoutChangeType {
  return classifyCheckout(currentForClassifier(sub, plans), {
    id: plan.code,
    quotaBytes: plan.quotaBytes,
    priceMonthSatang: plan.month.totalSatang,
    priceYearSatang: plan.year.totalSatang,
  });
}
