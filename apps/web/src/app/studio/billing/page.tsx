import { planCodeSchema } from '@shotx/shared';
import { BillingView } from '@/components/billing/billing-view';
import { clientBillingConfig } from '@/lib/server/config';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const { plan } = await searchParams;
  const planCode =
    typeof plan === 'string' && planCodeSchema.safeParse(plan).success ? plan : undefined;
  return (
    <BillingView
      pollIntervalMs={clientBillingConfig().paymentPollIntervalMs}
      initialPlanCode={planCode}
    />
  );
}
