import { planCodeSchema } from '@shotx/shared';
import { notFound } from 'next/navigation';
import { BillingView } from '@/components/billing/billing-view';
import { UsageBar } from '@/components/drive/usage-bar';
import { billingOffline, clientBillingConfig } from '@/lib/server/config';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Plans and payment; not there while BILLING_MODE=offline (ADR 0010: the API answers NOT_FOUND). */
export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  if (billingOffline()) notFound();
  const { plan } = await searchParams;
  const planCode =
    typeof plan === 'string' && planCodeSchema.safeParse(plan).success ? plan : undefined;
  return (
    <div className="space-y-6">
      <UsageBar />
      <BillingView
        pollIntervalMs={clientBillingConfig().paymentPollIntervalMs}
        initialPlanCode={planCode}
      />
    </div>
  );
}
