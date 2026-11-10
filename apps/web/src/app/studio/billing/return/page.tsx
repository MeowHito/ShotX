import { notFound } from 'next/navigation';
import { BillingReturn } from '@/components/billing/billing-return';
import { billingOffline, clientBillingConfig } from '@/lib/server/config';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** BILLING_CARD_RETURN_PATH: the gateway's card page returns here with `?payment={id}`. */
export default async function BillingReturnPage({ searchParams }: { searchParams: SearchParams }) {
  if (billingOffline()) notFound();
  const { payment } = await searchParams;
  return (
    <BillingReturn
      paymentId={typeof payment === 'string' ? payment : null}
      pollIntervalMs={clientBillingConfig().paymentPollIntervalMs}
    />
  );
}
