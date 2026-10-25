import { BillingReturn } from '@/components/billing/billing-return';
import { clientBillingConfig } from '@/lib/server/config';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** BILLING_CARD_RETURN_PATH: the gateway's card page returns here with `?payment={id}`. */
export default async function BillingReturnPage({ searchParams }: { searchParams: SearchParams }) {
  const { payment } = await searchParams;
  return (
    <BillingReturn
      paymentId={typeof payment === 'string' ? payment : null}
      pollIntervalMs={clientBillingConfig().paymentPollIntervalMs}
    />
  );
}
