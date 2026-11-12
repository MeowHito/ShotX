import { buttonVariants, cn } from '@shotx/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { LanguageSwitcher } from './language-switcher';
import { billingOffline } from '@/lib/server/config';

/**
 * The floating header of the public pages (home, pricing). No sign-up (ADR 0010: accounts come
 * from admins), and no "pricing" link while nothing can be bought online (BILLING_MODE=offline).
 */
export async function SiteHeader() {
  const t = await getTranslations();
  const offline = billingOffline();
  return (
    <header className="sticky top-3 z-40 mx-auto w-[calc(100%-1.5rem)] max-w-6xl">
      <div className="flex h-14 items-center gap-2 rounded-2xl border bg-background/90 px-3 shadow-float backdrop-blur-xl sm:px-4">
        <Link
          href="/"
          className="rounded-md px-1 text-lg font-bold tracking-[-0.015em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('common.appName')}
        </Link>
        {offline ? null : (
          <nav aria-label={t('site.navLabel')} className="ml-2 hidden sm:block">
            <Link
              href="/pricing"
              className="rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('site.pricing')}
            </Link>
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          <LanguageSwitcher />
          <Link
            href={AUTH_PATHS.loginPage}
            className={cn(buttonVariants({ size: 'sm' }), 'h-10 rounded-md')}
          >
            {t('site.login')}
          </Link>
        </div>
      </div>
    </header>
  );
}

/** The footer of the public pages. */
export async function SiteFooter() {
  const t = await getTranslations();
  const offline = billingOffline();
  return (
    <footer className="border-t bg-sidebar">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-10 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>
          <span className="font-bold tracking-[-0.015em] text-foreground">
            {t('common.appName')}
          </span>{' '}
          · {t('site.tagline')}
        </p>
        <nav aria-label={t('site.footerLabel')} className="flex gap-5">
          {offline ? null : (
            <Link href="/pricing" className="hover:text-foreground">
              {t('site.pricing')}
            </Link>
          )}
          <Link href={AUTH_PATHS.loginPage} className="hover:text-foreground">
            {t('site.login')}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
