'use client';

import { SUPPORTED_LOCALES, type SupportedLocale } from '@shotx/shared';
import { cn } from '@shotx/ui';
import { LanguagesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { reloadPage } from '@/lib/browser/navigate';
import { writeLocaleCookie } from '@/lib/i18n/locale-cookie';

/**
 * The current UI language and a chooser that stores a new one in LOCALE_COOKIE and reloads (so
 * the server renders every message in it). Shared by the switcher and the studio account menu.
 */
export function useChooseLocale(onChange?: (locale: SupportedLocale) => void) {
  const current = useLocale();
  function choose(locale: SupportedLocale) {
    if (locale === current) return;
    writeLocaleCookie(locale);
    if (onChange) onChange(locale);
    else reloadPage();
  }
  return { current, choose };
}

/**
 * The language choice, Thai / English / Chinese (ADR 0011): stores the choice in LOCALE_COOKIE and reloads, so the server
 * renders every message (and the consent text) in the new language. Each name is in its own
 * script, so anyone can find theirs.
 */
export function LanguageSwitcher({ onChange }: { onChange?: (locale: SupportedLocale) => void }) {
  const t = useTranslations('publicNav');
  const { current, choose } = useChooseLocale(onChange);
  return (
    <div role="group" aria-label={t('language')} className="flex items-center gap-1">
      <LanguagesIcon className="size-4 text-muted-foreground" aria-hidden />
      <div className="flex rounded-full border bg-background p-0.5">
        {SUPPORTED_LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            lang={locale}
            aria-pressed={locale === current}
            onClick={() => choose(locale)}
            className={cn(
              'h-9 min-w-11 rounded-full px-2.5 text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm',
              locale === current
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`locales.${locale}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
