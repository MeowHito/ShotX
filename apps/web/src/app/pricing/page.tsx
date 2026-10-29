import { Alert, buttonVariants, cn } from '@shotx/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PricingTable } from '@/components/billing/pricing-table';
import { SiteFooter, SiteHeader } from '@/components/site/site-header';
import { requestServerCallContext } from '@/lib/server/auth';
import { fetchPlans } from '@/lib/server/billing';
import { clientPricingConfig, webConfig } from '@/lib/server/config';

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
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl space-y-10 px-4 pt-14 pb-20 sm:px-6 sm:pt-20">
        <header className="mx-auto max-w-2xl space-y-3 text-center">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1 className="text-[clamp(2rem,3vw+1rem,3rem)] leading-tight">{t('title')}</h1>
          <p className="text-muted-foreground">{t('subtitle')}</p>
        </header>
        {plans === null ? (
          <Alert variant="destructive" className="mx-auto max-w-md text-center">
            {t('loadError')}
          </Alert>
        ) : (
          <PricingTable
            plans={plans}
            recommendedPlanCode={clientPricingConfig().recommendedPlanCode}
          />
        )}
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-sm text-muted-foreground">{t('trial')}</p>
          <Link
            href="/studio"
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'rounded-full')}
          >
            {t('startTrial')}
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
