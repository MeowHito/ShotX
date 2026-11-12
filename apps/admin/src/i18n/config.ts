import { DEFAULT_LOCALE as SHARED_DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@shotx/shared';
import { TIME_ZONE } from '../lib/format';
import { en } from '../messages/en';
import { withTranslation } from '../messages/translation';
import { type Messages, th } from '../messages/th';
import { zh } from '../messages/zh';

/**
 * UI languages of the admin app, as in the web app (ADR 0011): Thai (default), English and
 * Chinese (simplified), chosen with the language switcher on the sign-in page and in the admin
 * frame (LOCALE_COOKIE; src/i18n/request reads it). The cookie only picks the UI text and the
 * Intl number/date format; nothing else reads it.
 */
export const DEFAULT_LOCALE = SHARED_DEFAULT_LOCALE;
export const LOCALES = SUPPORTED_LOCALES;
export type Locale = (typeof LOCALES)[number];

export { TIME_ZONE };

export const MESSAGES = {
  th,
  en: withTranslation(en),
  zh: withTranslation(zh),
} as const satisfies Record<Locale, Messages>;

/** The `lang` attribute of a locale (Chinese is the simplified script). */
export const HTML_LANG = { th: 'th', en: 'en', zh: 'zh-Hans' } as const satisfies Record<
  Locale,
  string
>;

/** The BCP 47 locale for Intl number and date formatting (storage, money, times). */
export const INTL_LOCALE = { th: 'th-TH', en: 'en-GB', zh: 'zh-CN' } as const satisfies Record<
  Locale,
  string
>;

export function intlLocale(locale: string): string {
  return (INTL_LOCALE as Record<string, string>)[locale] ?? INTL_LOCALE.th;
}

export function htmlLang(locale: string): string {
  return (HTML_LANG as Record<string, string>)[locale] ?? HTML_LANG.th;
}
