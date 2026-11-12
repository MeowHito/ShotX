import { LOCALE_COOKIE, localeFromCookie } from '@shotx/shared';
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { MESSAGES, TIME_ZONE } from './config';

// No locale in the URL (share links stay the same in every language): the viewer's choice from
// the top-bar switcher (LOCALE_COOKIE), else Thai. Accept-Language is not consulted.
export default getRequestConfig(async () => {
  const locale = localeFromCookie((await cookies()).get(LOCALE_COOKIE)?.value);
  return { locale, messages: MESSAGES[locale], timeZone: TIME_ZONE };
});
