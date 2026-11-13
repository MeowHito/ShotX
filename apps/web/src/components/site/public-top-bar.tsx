'use client';

import { cn } from '@shotx/ui';
import { HomeIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { LanguageSwitcher } from './language-switcher';

/**
 * The public pages' top bar (ADR 0011): a home link and the language switcher. `overlay` (a
 * share page's designed first screen, owner 2026-11-13): it floats over the design, transparent,
 * so it never hides the design's top (the event logo); once the page is scrolled past most of
 * the first screen it turns solid again over the photos.
 */
export function PublicTopBar({ overlay = false }: { overlay?: boolean }) {
  const t = useTranslations();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!overlay) return;
    const update = () => setScrolled(window.scrollY > window.innerHeight * 0.7);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [overlay]);
  const clear = overlay && !scrolled;
  return (
    <header
      data-overlay={overlay ? (clear ? 'clear' : 'solid') : undefined}
      className={cn(
        'top-0 z-30 pt-[env(safe-area-inset-top)] transition-colors duration-200',
        overlay ? 'fixed inset-x-0' : 'sticky',
        clear
          ? 'border-b border-transparent bg-transparent'
          : 'border-b bg-background/90 backdrop-blur',
      )}
    >
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
