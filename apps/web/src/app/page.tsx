import { buttonVariants, cn } from '@shotx/ui';
import {
  ArrowRightIcon,
  DownloadIcon,
  FolderTreeIcon,
  LinkIcon,
  type LucideIcon,
  ReceiptTextIcon,
  ScanFaceIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SiteFooter, SiteHeader } from '@/components/site/site-header';

const STEPS = ['upload', 'share', 'find'] as const;

const FEATURES: {
  id: 'drive' | 'share' | 'face' | 'download' | 'privacy' | 'pricing';
  icon: LucideIcon;
}[] = [
  { id: 'drive', icon: FolderTreeIcon },
  { id: 'share', icon: LinkIcon },
  { id: 'face', icon: ScanFaceIcon },
  { id: 'download', icon: DownloadIcon },
  { id: 'privacy', icon: ShieldCheckIcon },
  { id: 'pricing', icon: ReceiptTextIcon },
];

/**
 * The public home page: a calm editorial hero for photographers, how it works, what is
 * included, and how faces are handled. Only honest copy: no numbers, logos or quotes.
 */
export default async function HomePage() {
  const t = await getTranslations('home');
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl gap-12 px-6 pt-16 pb-[clamp(4rem,5.8vw,5.5rem)] sm:pt-24 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <div className="space-y-6">
            <p className="eyebrow">{t('eyebrow')}</p>
            <h1 className="text-[clamp(2.3rem,3.6vw+1rem,3.75rem)] leading-[1.16]">
              {t('headingLine1')}
              <br />
              {t('headingLine2')}
            </h1>
            <p className="max-w-xl text-base text-muted-foreground sm:text-lg sm:leading-[1.75]">
              {t('lead')}
            </p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <Link
                href="/studio"
                className={cn(buttonVariants({ size: 'lg' }), 'h-12 rounded-full px-6 text-base')}
              >
                {t('start')}
                <ArrowRightIcon aria-hidden />
              </Link>
              <Link
                href="/pricing"
                className="text-sm font-semibold text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                {t('pricing')}
              </Link>
            </div>
            <p className="text-sm text-muted-foreground">{t('micro')}</p>
          </div>
          <ol
            className="space-y-3 rounded-3xl border bg-sidebar p-4 sm:p-6"
            aria-label={t('stepsLabel')}
          >
            {STEPS.map((step, i) => (
              <li key={step} className="flex gap-4 rounded-xl border bg-background p-5 shadow-card">
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-primary tabular-nums"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="space-y-1">
                  <h2 className="text-base">{t(`steps.${step}.title`)}</h2>
                  <p className="text-sm text-muted-foreground">{t(`steps.${step}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y bg-sidebar">
          <div className="mx-auto max-w-6xl space-y-10 px-6 py-[clamp(4rem,5.8vw,5.5rem)]">
            <div className="max-w-2xl space-y-3">
              <p className="eyebrow">{t('featuresEyebrow')}</p>
              <h2 className="text-[clamp(1.6rem,2vw+0.6rem,2rem)] leading-tight">
                {t('featuresTitle')}
              </h2>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ id, icon: Icon }) => (
                <li key={id} className="space-y-3 rounded-xl border bg-background p-6 shadow-card">
                  <Icon className="size-6 text-primary" strokeWidth={1.75} aria-hidden />
                  <h3 className="text-lg">{t(`features.${id}.title`)}</h3>
                  <p className="text-sm text-muted-foreground">{t(`features.${id}.body`)}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="bg-band text-band-foreground">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-[clamp(4rem,5.8vw,5.5rem)] lg:grid-cols-2 lg:items-center">
            <div className="space-y-3">
              <p className="text-xs font-bold tracking-[0.02em] text-[#9fc2d8]">
                {t('privacyEyebrow')}
              </p>
              <h2 className="text-[clamp(1.6rem,2vw+0.6rem,2rem)] leading-tight text-band-foreground">
                {t('privacyTitle')}
              </h2>
            </div>
            <ul className="divide-y divide-white/10 border-y border-white/10">
              {(['consent', 'noSelfie', 'delete'] as const).map((id) => (
                <li key={id} className="py-4 text-sm leading-[1.75] text-[#cfd8de]">
                  {t(`privacy.${id}`)}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto max-w-3xl space-y-5 px-6 py-[clamp(4rem,5.8vw,5.5rem)] text-center">
          <h2 className="text-[clamp(1.6rem,2vw+0.6rem,2rem)] leading-tight">{t('ctaTitle')}</h2>
          <p className="text-muted-foreground">{t('ctaBody')}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/studio"
              className={cn(buttonVariants({ size: 'lg' }), 'h-12 rounded-full px-6 text-base')}
            >
              {t('start')}
            </Link>
            <Link
              href="/login"
              className={cn(
                buttonVariants({ size: 'lg', variant: 'outline' }),
                'h-12 rounded-full px-6 text-base',
              )}
            >
              {t('login')}
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
