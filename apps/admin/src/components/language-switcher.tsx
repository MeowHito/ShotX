'use client';

import { SUPPORTED_LOCALES, type SupportedLocale } from '@shotx/shared';
import { cn } from '@shotx/ui';
import { LanguagesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { HTML_LANG } from '@/i18n/config';
import { writeLocaleCookie } from '@/lib/i18n/locale-cookie';
import { reloadPage } from '@/lib/i18n/navigate';

/**
 * The UI language, Thai / English / Chinese, as in the web app: stores the choice in
 * LOCALE_COOKIE (client-side, only the SUPPORTED_LOCALES values it renders) and reloads, so the
 * server renders every message in the new language. Each name is in its own script, so anyone can
 * find theirs. On the sign-in page and in the admin frame's account box.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations('language');
  const current = useLocale();

  function choose(locale: SupportedLocale) {
    if (locale === current) return;
    writeLocaleCookie(locale);
    reloadPage();
  }

  return (
    <div role="group" aria-label={t('label')} className={cn('flex items-center gap-1', className)}>
      <LanguagesIcon className="size-4 text-muted-foreground" aria-hidden />
      <div className="flex rounded-full border bg-background p-0.5">
        {SUPPORTED_LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            lang={HTML_LANG[locale]}
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
