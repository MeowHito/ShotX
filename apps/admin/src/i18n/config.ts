import { TIME_ZONE } from '../lib/format';
import { th } from '../messages/th';

/** Thai is the default and only locale for now. */
export const DEFAULT_LOCALE = 'th';
export const LOCALES = [DEFAULT_LOCALE] as const;
export type Locale = (typeof LOCALES)[number];

export { TIME_ZONE };

export const MESSAGES = { th } as const satisfies Record<Locale, unknown>;
