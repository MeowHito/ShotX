import { z } from 'zod';

/**
 * UI languages of the public pages (ADR 0011): share page, face search, results, downloads and
 * consent. Thai is the default and the legal reference of every consent text; English and Chinese
 * (simplified) are translations the DPO approves. The studio and the admin app stay Thai.
 *
 * The texts live in web's i18n messages (`satisfies Record<SupportedLocale, ...>`), never here.
 * Adding a locale here needs a migration too: `consents.locale` is the `ui_locale` enum.
 */
export const SUPPORTED_LOCALES = ['th', 'en', 'zh'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'th';

export const supportedLocaleSchema = z.enum(SUPPORTED_LOCALES);

/**
 * Cookie with the viewer's language choice from the top-bar switcher, set by web (not httpOnly:
 * the client switcher writes it; it holds nothing secret). Path `/`, SameSite=Lax, Max-Age
 * LOCALE_COOKIE_MAX_AGE_DAYS. A missing or unknown value means DEFAULT_LOCALE (see
 * localeFromCookie); web does not guess from Accept-Language (assumption: the operator wants
 * Thai first for everyone, the switcher is one tap away).
 */
export const LOCALE_COOKIE = 'shotx_locale';

/** Lifetime of LOCALE_COOKIE (assumption: one year, like the anon cookie). */
export const LOCALE_COOKIE_MAX_AGE_DAYS = 365;

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** The locale a cookie value selects: the value when supported, else DEFAULT_LOCALE. */
export function localeFromCookie(value: string | null | undefined): SupportedLocale {
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}
