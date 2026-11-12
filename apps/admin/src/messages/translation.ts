import type { Messages } from './th';

/** The same shape as the Thai messages with every message a plain string. */
export type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };

/**
 * A translation of the admin app: every key of messages/th.ts, required by the type, so a key
 * added to th.ts fails typecheck until en.ts and zh.ts have it (locales.test.ts also checks that
 * there are no extra keys and that the ICU arguments match).
 */
export type TranslatedMessages = Widen<Messages>;

/**
 * A complete bundle in another language. The keys are exactly Messages' (the type above); only
 * the strings differ from the Thai literal types next-intl infers its key checks from.
 */
export function withTranslation(messages: TranslatedMessages): Messages {
  return messages as unknown as Messages;
}
