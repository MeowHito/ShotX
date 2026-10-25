import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from './config';

// No locale in the URL: every request is Thai until a second locale exists.
export default getRequestConfig(() =>
  Promise.resolve({
    locale: DEFAULT_LOCALE,
    messages: MESSAGES[DEFAULT_LOCALE],
    timeZone: TIME_ZONE,
  }),
);
