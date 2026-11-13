'use client';

import { SUPPORTED_LOCALES, type SupportedLocale } from '@shotx/shared';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@shotx/ui';
import { ChevronDownIcon, LanguagesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { HTML_LANG } from '@/i18n/config';
import { writeLocaleCookie } from '@/lib/i18n/locale-cookie';
import { reloadPage } from '@/lib/i18n/navigate';
import { LocaleFlag } from './locale-flag';

/**
 * The UI language, Thai / English / Chinese, as in the web app: stores the choice in
 * LOCALE_COOKIE (client-side, only the SUPPORTED_LOCALES values it renders) and reloads, so the
 * server renders every message in the new language. Each name is in its own script, so anyone can
 * find theirs. On the sign-in page (the signed-in frame uses {@link LanguageMenu}).
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

/**
 * The admin frame's language choice (owner, 2026-11-13): a compact flag button at the top right
 * that opens Thai / English / Chinese, as in the web app's top bar, instead of the pills in the
 * account box. Same cookie and reload as {@link LanguageSwitcher}.
 */
export function LanguageMenu({ className }: { className?: string }) {
  const t = useTranslations('language');
  const current = useLocale();
  const active = (SUPPORTED_LOCALES as readonly string[]).includes(current) ? current : null;

  function choose(value: string) {
    if (value === current || !(SUPPORTED_LOCALES as readonly string[]).includes(value)) return;
    writeLocaleCookie(value as SupportedLocale);
    reloadPage();
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-sm font-semibold text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent',
            className,
          )}
        >
          <span className="sr-only">
            {t('label')}{' '}
            {active !== null ? (
              <span lang={HTML_LANG[active]}>{t(`locales.${active}`)}</span>
            ) : null}
          </span>
          {active !== null ? <LocaleFlag locale={active} className="h-4 w-6" /> : null}
          <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={12} className="min-w-44">
        <DropdownMenuRadioGroup value={current} onValueChange={choose}>
          {SUPPORTED_LOCALES.map((locale) => (
            <DropdownMenuRadioItem
              key={locale}
              value={locale}
              lang={HTML_LANG[locale]}
              className="min-h-11 gap-2.5 text-base"
            >
              <LocaleFlag locale={locale} className="h-3.5 w-5" />
              {t(`locales.${locale}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
