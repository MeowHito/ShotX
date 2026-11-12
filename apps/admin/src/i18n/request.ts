import { LOCALE_COOKIE, localeFromCookie } from '@shotx/shared';
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { MESSAGES, TIME_ZONE } from './config';

// No locale in the URL: the admin's choice from the language switcher (LOCALE_COOKIE, the same
// cookie name as the web app, host-only on the admin host), else Thai. An unknown value falls back
// to Thai (localeFromCookie only accepts SUPPORTED_LOCALES). Accept-Language is not consulted.
export default getRequestConfig(async () => {
  const locale = localeFromCookie((await cookies()).get(LOCALE_COOKIE)?.value);
  return { locale, messages: MESSAGES[locale], timeZone: TIME_ZONE };
});
