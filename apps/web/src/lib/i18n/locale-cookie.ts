import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_DAYS, type SupportedLocale } from '@shotx/shared';

/**
 * The LOCALE_COOKIE value the switcher writes: Path=/ (every page), a year, SameSite=Lax, Secure
 * on https. Not httpOnly by design (the client writes it; it holds nothing secret).
 */
export function localeCookie(locale: SupportedLocale, secure: boolean): string {
  const maxAge = LOCALE_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Stores the choice in the browser (the switcher's tap handler). */
export function writeLocaleCookie(locale: SupportedLocale): void {
  document.cookie = localeCookie(locale, window.location.protocol === 'https:');
}
