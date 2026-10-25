import { th } from '../messages/th';

/** Thai is the default and only locale for now. */
export const DEFAULT_LOCALE = 'th';
export const LOCALES = [DEFAULT_LOCALE] as const;
export type Locale = (typeof LOCALES)[number];

/** Dates and times are shown in Thailand's time zone wherever the viewer is. */
export const TIME_ZONE = 'Asia/Bangkok';

export const MESSAGES = { th } as const satisfies Record<Locale, unknown>;
