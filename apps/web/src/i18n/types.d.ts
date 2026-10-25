import type { Locale } from './config';
import type { Messages } from '../messages/th';

// Typed keys and ICU arguments: `t('missing.key')` or a missing placeholder fails typecheck.
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
