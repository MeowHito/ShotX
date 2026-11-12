import { DEFAULT_LOCALE as SHARED_DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@shotx/shared';
import { en } from '../messages/en';
import { withPublicMessages } from '../messages/public';
import { type Messages, th } from '../messages/th';
import { zh } from '../messages/zh';

/**
 * UI languages (ADR 0011): Thai (default), English and Chinese (simplified), chosen with the
 * public top bar's switcher (LOCALE_COOKIE; src/i18n/request reads it). The public pages are fully
 * translated; the studio, login, home and pricing stay Thai (see messages/public).
 */
export const DEFAULT_LOCALE = SHARED_DEFAULT_LOCALE;
export const LOCALES = SUPPORTED_LOCALES;
export type Locale = (typeof LOCALES)[number];

/** Dates and times are shown in Thailand's time zone wherever the viewer is. */
export const TIME_ZONE = 'Asia/Bangkok';

export const MESSAGES = {
  th,
  en: withPublicMessages(th, en),
  zh: withPublicMessages(th, zh),
} as const satisfies Record<Locale, Messages>;

/** The `lang` attribute of a locale (Chinese is the simplified script). */
export const HTML_LANG = { th: 'th', en: 'en', zh: 'zh-Hans' } as const satisfies Record<
  Locale,
  string
>;
