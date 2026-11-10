import { z } from 'zod';

// Email + password accounts (ADR 0010): admins (admins pool, `admin:` subjects, admin_credentials)
// and photographers (users pool, `password:` subjects, user_password_credentials). Pure shapes and
// helpers; hashing (argon2id) and verification live in the api.

/** Longest email accepted for an account (RFC 5321 path limit). */
export const ACCOUNT_EMAIL_MAX_LENGTH = 254;

/**
 * The key account emails are unique on: trimmed, ASCII A-Z lowercased (other characters kept), the
 * same as `lower(email COLLATE "C")` in `users_password_account_email_unique` and
 * `users_admin_email_unique`. Use it for lookups, rate-limit keys and audit HMACs; store the email
 * as the admin typed it (trimmed).
 */
export function normalizeAccountEmail(email: string): string {
  return email.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** An account email in a request: trimmed, then a valid address of at most 254 characters. */
export const accountEmailSchema = z
  .string()
  .trim()
  .pipe(z.email({ error: 'must be an email address' }).max(ACCOUNT_EMAIL_MAX_LENGTH));

/** A display name in a request: trimmed, 1-200 characters (same as `devLoginBodySchema.name`). */
export const accountNameSchema = z.string().trim().min(1).max(200);

/**
 * Longest new password, in UTF-16 code units (the schema bound; VALIDATION_FAILED above it).
 * Sign-in bodies accept up to 1024 so an over-long typo is INVALID_CREDENTIALS, not a validation
 * error that tells the password policy.
 */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * A password being set (create, reset, change). The schema only bounds it; the minimum length
 * comes from config (ADMIN_PASSWORD_MIN_LENGTH or PHOTOGRAPHER_PASSWORD_MIN_LENGTH) and the API
 * answers PASSWORD_TOO_WEAK (details PasswordTooWeakDetails) using passwordPolicyViolation.
 * Never trimmed: spaces are part of the password.
 */
export const newPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/**
 * Why a new password is refused (PASSWORD_TOO_WEAK details `reason`):
 * - `too_short`: fewer Unicode code points than the pool's minimum (details `minLength`);
 * - `too_simple`: fewer than PASSWORD_MIN_DISTINCT_CHARACTERS distinct characters, or one
 *   ascending or descending run (`abcdefghij`, `9876543210`, `1234567890`);
 * - `contains_email`: contains the account's email, or its local part when that has at least
 *   PASSWORD_EMAIL_LOCAL_PART_MIN characters (ASCII case ignored);
 * - `common`: on the API's list of common passwords (if it has one);
 * - `same_as_current`: the new password equals the current one (checked with the stored hash).
 * passwordPolicyViolation checks the first three; the API adds the last two.
 */
export const PASSWORD_POLICY_REASONS = [
  'too_short',
  'too_simple',
  'contains_email',
  'common',
  'same_as_current',
] as const;
export type PasswordPolicyReason = (typeof PASSWORD_POLICY_REASONS)[number];

/** A password needs at least this many distinct characters (code points). */
export const PASSWORD_MIN_DISTINCT_CHARACTERS = 4;

/** The email's local part counts as "in the password" from this length. */
export const PASSWORD_EMAIL_LOCAL_PART_MIN = 3;

export interface PasswordPolicy {
  /** ADMIN_PASSWORD_MIN_LENGTH or PHOTOGRAPHER_PASSWORD_MIN_LENGTH. */
  minLength: number;
  /** The account's email, when known. */
  email?: string | null;
}

const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;

/**
 * One ascending or descending run of consecutive characters (`abcdefghij`, `9876543210`); digits
 * wrap around, so `1234567890` is a run too.
 */
function isSingleRun(codePoints: number[]): boolean {
  if (codePoints.length < 3) return false;
  const digits = codePoints.every((c) => c >= DIGIT_0 && c <= DIGIT_9);
  const delta = (a: number, b: number) => (digits ? (((b - a) % 10) + 10) % 10 : b - a);
  const step = delta(codePoints[0] as number, codePoints[1] as number);
  const up = 1;
  const down = digits ? 9 : -1;
  if (step !== up && step !== down) return false;
  return codePoints.every((c, i) => i === 0 || delta(codePoints[i - 1] as number, c) === step);
}

/**
 * The first rule `password` breaks among `too_short`, `too_simple` and `contains_email`, or null.
 * Pure: the API also checks `common` and `same_as_current`.
 */
export function passwordPolicyViolation(
  password: string,
  policy: PasswordPolicy,
): PasswordPolicyReason | null {
  if (!Number.isInteger(policy.minLength) || policy.minLength < 1) {
    throw new RangeError('minLength must be a positive integer');
  }
  const codePoints = [...password].map((c) => c.codePointAt(0) as number);
  if (codePoints.length < policy.minLength) return 'too_short';
  if (new Set(codePoints).size < PASSWORD_MIN_DISTINCT_CHARACTERS || isSingleRun(codePoints)) {
    return 'too_simple';
  }
  if (policy.email !== undefined && policy.email !== null) {
    const email = normalizeAccountEmail(policy.email);
    const folded = password.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const at = email.lastIndexOf('@');
    const local = at > 0 ? email.slice(0, at) : email;
    if (
      (email !== '' && folded.includes(email)) ||
      (local.length >= PASSWORD_EMAIL_LOCAL_PART_MIN && folded.includes(local))
    ) {
      return 'contains_email';
    }
  }
  return null;
}
