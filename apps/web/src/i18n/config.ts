import { DEFAULT_LOCALE as SHARED_DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@shotx/shared';
import { en } from '../messages/en';
import { enStudio } from '../messages/en-studio';
import { withTranslation } from '../messages/public';
import { type Messages, th } from '../messages/th';
import { zh } from '../messages/zh';
import { zhStudio } from '../messages/zh-studio';

/**
 * UI languages (ADR 0011): Thai (default), English and Chinese (simplified), chosen with the
 * language switcher on every page (LOCALE_COOKIE; src/i18n/request reads it). Every page is
 * translated (see messages/public); only consent texts older than the translated versions stay
 * Thai, the legal reference.
 */
export const DEFAULT_LOCALE = SHARED_DEFAULT_LOCALE;
export const LOCALES = SUPPORTED_LOCALES;
export type Locale = (typeof LOCALES)[number];

/** Dates and times are shown in Thailand's time zone wherever the viewer is. */
export const TIME_ZONE = 'Asia/Bangkok';

export const MESSAGES = {
  th,
  en: withTranslation(th, en, enStudio),
  zh: withTranslation(th, zh, zhStudio),
} as const satisfies Record<Locale, Messages>;

/** The `lang` attribute of a locale (Chinese is the simplified script). */
export const HTML_LANG = { th: 'th', en: 'en', zh: 'zh-Hans' } as const satisfies Record<
  Locale,
  string
>;

/** The BCP 47 locale for Intl number and date formatting (byte sizes, prices, times). */
export const INTL_LOCALE = { th: 'th-TH', en: 'en-GB', zh: 'zh-CN' } as const satisfies Record<
  Locale,
  string
>;

export function intlLocale(locale: string): string {
  return (INTL_LOCALE as Record<string, string>)[locale] ?? INTL_LOCALE.th;
}
