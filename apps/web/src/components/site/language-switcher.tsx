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
import { ChevronDownIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { HTML_LANG } from '@/i18n/config';
import { reloadPage } from '@/lib/browser/navigate';
import { writeLocaleCookie } from '@/lib/i18n/locale-cookie';
import { LocaleFlag } from './locale-flag';

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

function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The language choice in the top bar (ADR 0011, owner feedback 2026-11-12): a compact button
 * showing the current language's flag (Thailand, United States, China; no short text), 44px
 * tall, that opens a menu of Thai / English / Chinese, each with its flag and its name in its own
 * script with `lang`, the current one checked. Choosing stores LOCALE_COOKIE and reloads, so the server renders every message (and
 * the consent text) in the new language. Radix gives the menu button semantics (aria-haspopup,
 * aria-expanded), arrow keys, and Escape back to the button.
 */
export function LanguageSwitcher({
  onChange,
  className,
}: {
  onChange?: (locale: SupportedLocale) => void;
  className?: string;
}) {
  const t = useTranslations('publicNav');
  const { current, choose } = useChooseLocale(onChange);
  const active = isSupportedLocale(current) ? current : null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full border bg-background px-3 text-sm font-semibold text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent',
            className,
          )}
        >
          {/* Accessible name: "Language English" (publicNav.language, then the language). */}
          <span className="sr-only">
            {t('language')}{' '}
            {active !== null ? (
              <span lang={HTML_LANG[active]}>{t(`locales.${active}`)}</span>
            ) : null}
          </span>
          {active !== null ? <LocaleFlag locale={active} className="h-5 w-[30px]" /> : null}
          <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={12} className="min-w-44">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(value) => {
            if (isSupportedLocale(value)) choose(value);
          }}
        >
          {SUPPORTED_LOCALES.map((locale) => (
            <DropdownMenuRadioItem
              key={locale}
              value={locale}
              lang={HTML_LANG[locale]}
              className="min-h-11 gap-2.5 text-base"
            >
              <LocaleFlag locale={locale} className="h-4 w-6" />
              {t(`locales.${locale}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
