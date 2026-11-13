import {
  type AccountRole,
  type AdminPasswordUiConfig,
  type PasswordPolicyReason,
  passwordPolicyViolation,
  temporaryPasswordViolation,
} from '@shotx/shared';

/**
 * Password settings the users dialogs receive from the server (src/lib/server/config): the length
 * of generated passwords and each pool's minimum (ADMIN_PASSWORD_MIN_LENGTH,
 * PHOTOGRAPHER_PASSWORD_MIN_LENGTH, read with the shared policy loaders the API uses).
 */
export type PasswordUiConfig = AdminPasswordUiConfig;

/**
 * Whether a typed initial (temporary) password is too short (ADR 0015: only the length counts;
 * the first sign-in replaces it), checked before calling the API, which stays the authority.
 */
export function initialPasswordProblem(
  password: string,
  role: AccountRole,
  config: PasswordUiConfig,
): { reason: PasswordPolicyReason; minLength: number } | null {
  const minLength = config.minLength[role];
  const reason = temporaryPasswordViolation(password, minLength);
  return reason === null ? null : { reason, minLength };
}

/**
 * Initial passwords made by the "generate" button. Characters a person reading the password aloud
 * or copying it from a screen won't confuse (no 0/O, 1/l/I), from three classes, picked uniformly
 * from the CSPRNG (crypto.getRandomValues, rejection sampling: no modulo bias). The result is
 * never logged or stored by the admin app; it lives in the open dialog's form state only.
 */

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
export const PASSWORD_ALPHABET = `${LOWER}${UPPER}${DIGITS}`;

/** Fills a buffer with random bytes (crypto.getRandomValues in the browser and in Node). */
export type RandomBytes = (buffer: Uint8Array) => Uint8Array;

const defaultRandom: RandomBytes = (buffer) => crypto.getRandomValues(buffer);

/** A uniformly random index below `n` (n ≤ 256). */
function randomIndex(n: number, random: RandomBytes): number {
  const limit = 256 - (256 % n);
  const byte = new Uint8Array(1);
  for (;;) {
    random(byte);
    const value = byte[0] as number;
    if (value < limit) return value % n;
  }
}

function hasEveryClass(password: string): boolean {
  const has = (set: string) => [...password].some((c) => set.includes(c));
  return has(LOWER) && has(UPPER) && has(DIGITS);
}

/**
 * A random password of `length` characters (at least 16) with a lower-case letter, an upper-case
 * letter and a digit, that passes the shared policy checks (passwordPolicyViolation) for `email`.
 */
export function generatePassword(
  length: number,
  options: { email?: string | null; random?: RandomBytes } = {},
): string {
  if (!Number.isInteger(length) || length < 16 || length > 256) {
    throw new RangeError('length must be an integer from 16 to 256');
  }
  const random = options.random ?? defaultRandom;
  for (;;) {
    let password = '';
    for (let i = 0; i < length; i++) {
      password += PASSWORD_ALPHABET[randomIndex(PASSWORD_ALPHABET.length, random)];
    }
    if (
      hasEveryClass(password) &&
      passwordPolicyViolation(password, { minLength: length, email: options.email }) === null
    ) {
      return password;
    }
  }
}
