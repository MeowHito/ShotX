import { Alert, buttonVariants } from '@shotx/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PricingTable } from '@/components/billing/pricing-table';
import { requestServerCallContext } from '@/lib/server/auth';
import { fetchPlans } from '@/lib/server/billing';
import { webConfig } from '@/lib/server/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pricing');
  return { title: t('title'), description: t('subtitle') };
}

/** Public `/pricing`: plans and prices from `GET /plans`, rendered on the server. */
export default async function PricingPage() {
  const t = await getTranslations('pricing');
  const plans = await fetchPlans({
    apiInternalUrl: webConfig().apiInternalUrl,
    context: await requestServerCallContext(),
  });
  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </header>
      {plans === null ? (
        <Alert variant="destructive" className="mx-auto max-w-md text-center">
          {t('loadError')}
        </Alert>
      ) : (
        <PricingTable plans={plans} />
      )}
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-sm text-muted-foreground">{t('trial')}</p>
        <Link href="/studio" className={buttonVariants({ variant: 'outline' })}>
          {t('startTrial')}
        </Link>
      </div>
    </main>
  );
}
