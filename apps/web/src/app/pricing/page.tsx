import { Alert, buttonVariants, cn } from '@shotx/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PricingTable } from '@/components/billing/pricing-table';
import { SiteFooter, SiteHeader } from '@/components/site/site-header';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { requestServerCallContext } from '@/lib/server/auth';
import { fetchPlans } from '@/lib/server/billing';
import { billingOffline, clientPricingConfig, webConfig } from '@/lib/server/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pricing');
  if (billingOffline()) return { title: t('offline.title'), description: t('offline.subtitle') };
  return { title: t('title'), description: t('subtitle') };
}

const OFFLINE_STEPS = ['contact', 'receive', 'signIn'] as const;

/**
 * Public `/pricing`.
 * - BILLING_MODE=gateway: plans and prices from `GET /plans`, rendered on the server.
 * - BILLING_MODE=offline (ADR 0010): nothing to buy and no plan list (GET /plans answers
 *   NOT_FOUND). The page stays for old links and explains how a photographer gets an account:
 *   pay and ask the admin, receive an email and temporary password, sign in.
 */
export default async function PricingPage() {
  const t = await getTranslations('pricing');
  if (billingOffline()) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto max-w-2xl space-y-10 px-4 pt-14 pb-20 sm:px-6 sm:pt-20">
          <header className="space-y-3 text-center">
            <p className="eyebrow">{t('offline.eyebrow')}</p>
            <h1 className="text-[clamp(2rem,3vw+1rem,3rem)] leading-tight">{t('offline.title')}</h1>
            <p className="text-muted-foreground">{t('offline.subtitle')}</p>
          </header>
          <ol className="space-y-3" aria-label={t('offline.stepsLabel')}>
            {OFFLINE_STEPS.map((step, i) => (
              <li key={step} className="flex gap-4 rounded-xl border bg-background p-5 shadow-card">
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-primary tabular-nums"
                >
                  {i + 1}
                </span>
                <p className="self-center text-sm">{t(`offline.steps.${step}`)}</p>
              </li>
            ))}
          </ol>
          <div className="flex justify-center">
            <Link
              href={AUTH_PATHS.loginPage}
              className={cn(buttonVariants({ size: 'lg' }), 'h-12 rounded-full px-6')}
            >
              {t('offline.login')}
            </Link>
          </div>
        </main>
        <SiteFooter />
      </>
    );
  }

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
      </main>
      <SiteFooter />
    </>
  );
}
