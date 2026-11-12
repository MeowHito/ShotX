'use client';

import { HomeIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from './language-switcher';

/** The public pages' top bar (ADR 0011): a home link and the language switcher. */
export function PublicTopBar() {
  const t = useTranslations();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur">
      <nav
        aria-label={t('publicNav.label')}
        className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-3 sm:px-6"
      >
        <Link
          href="/"
          className="flex h-11 items-center gap-2 rounded-md px-1 text-base font-bold tracking-[-0.015em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HomeIcon className="size-5 text-primary" aria-hidden />
          <span>{t('common.appName')}</span>
          <span className="sr-only">{t('publicNav.home')}</span>
        </Link>
        <LanguageSwitcher />
      </nav>
    </header>
  );
}
