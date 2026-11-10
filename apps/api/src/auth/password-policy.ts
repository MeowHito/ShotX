import {
  type PasswordPolicyReason,
  type PasswordTooWeakDetails,
  passwordPolicyViolation,
} from '@shotx/shared';
import { ApiError } from '../http/api-error';
import { verifyPassword } from './password';

// The password policy of ADR 0010 accounts (admins and photographers): the shared rules
// (passwordPolicyViolation: too_short, too_simple, contains_email), then the API's own: a list of
// common passwords and "not the current one".

/**
 * Passwords that appear at the top of every breached-password list (lowercased; compared after
 * ASCII lowercasing). Only entries long enough to pass the shortest configurable minimum (8)
 * matter: shorter ones are already `too_short`. Not secrets: a deny list.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '1q2w3e4r5t',
  '1qaz2wsx',
  '1qaz2wsx3edc',
  'a1b2c3d4',
  'aa123456',
  'abc12345',
  'abcd1234',
  'admin123',
  'admin1234',
  'administrator',
  'asdf1234',
  'asdfghjkl',
  'baseball',
  'computer',
  'dragon123',
  'football',
  'iloveyou',
  'iloveyou1',
  'letmein1',
  'login123',
  'master123',
  'monkey123',
  'p@ssw0rd',
  'p@ssword',
  'passw0rd',
  'password',
  'password!',
  'password1',
  'password12',
  'password123',
  'password1234',
  'princess',
  'q1w2e3r4',
  'q1w2e3r4t5',
  'qwer1234',
  'qwerty12',
  'qwerty123',
  'qwerty1234',
  'qwertyuiop',
  'shotx1234',
  'starwars',
  'sunshine',
  'superman',
  'trustno1',
  'welcome1',
  'welcome123',
  'zaq12wsx',
  'zxcvbnm1',
]);

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** True when `password` is on the API's common-password list (ASCII case ignored). */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(asciiLower(password.normalize('NFC')));
}

export const passwordTooWeak = (reason: PasswordPolicyReason, minLength: number) =>
  new ApiError('PASSWORD_TOO_WEAK', 'The new password is too weak', {
    reason,
    minLength,
  } satisfies PasswordTooWeakDetails);

/**
 * PASSWORD_TOO_WEAK (details PasswordTooWeakDetails) unless `password` passes the policy:
 * passwordPolicyViolation with the pool's minimum and the account's email, the common list, and,
 * when `currentHash` is given, `same_as_current` (one argon2id verification). Never logs the
 * password.
 */
export async function assertPasswordPolicy(
  password: string,
  policy: { minLength: number; email: string | null; currentHash?: string | null },
): Promise<void> {
  const violation = passwordPolicyViolation(password, {
    minLength: policy.minLength,
    email: policy.email,
  });
  if (violation !== null) throw passwordTooWeak(violation, policy.minLength);
  if (isCommonPassword(password)) throw passwordTooWeak('common', policy.minLength);
  if (
    policy.currentHash !== undefined &&
    policy.currentHash !== null &&
    (await verifyPassword(password, policy.currentHash))
  ) {
    throw passwordTooWeak('same_as_current', policy.minLength);
  }
}
