import { planCodeSchema } from '@shotx/shared';
import { BillingView } from '@/components/billing/billing-view';
import { UsageBar } from '@/components/drive/usage-bar';
import { clientBillingConfig } from '@/lib/server/config';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
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
