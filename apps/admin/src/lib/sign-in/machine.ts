import { ErrorCode } from '@shotx/shared';
import type { SignInStepView } from './protocol';

/**
 * The admin sign-in as a pure state machine (ADMIN_SIGN_IN_STEPS_BY_MODE). The API decides the
 * steps; the machine only refuses answers that can't follow the current step.
 *
 *   ADMIN_MFA_MODE=off:   credentials ─┬─> change_password ──> signed_in
 *                                      └──────────────────────> signed_in
 *   ADMIN_MFA_MODE=totp:  credentials ─┬─> change_password ─┬─> enrol_totp ─┐
 *                                      ├────────────────────┼──────────────>├─> signed_in
 *                                      └─> enrol_totp / totp └─> totp ──────┘
 *
 * The session cookies are set by the admin app's route handlers only from the API's `signed_in`
 * answer, so this machine can't sign anyone in by itself. Any answer that doesn't fit the current
 * step sends the person back to the start; so does a used-up or expired challenge
 * (LOGIN_STATE_INVALID). The enrolment URI lives in the state only while the `enrol_totp` step is
 * shown and is dropped on any move.
 */

export type SignInState =
  | { step: 'credentials'; notice: SignInNotice | null }
  | { step: 'change_password' }
  | { step: 'enrol_totp'; otpauthUri: string }
  | { step: 'totp' }
  | { step: 'signed_in' };

/** Why the flow went back to the start. */
export type SignInNotice = 'expired' | 'unexpected';

export const INITIAL_SIGN_IN_STATE: SignInState = { step: 'credentials', notice: null };

/** Which answers each step may receive. */
const ALLOWED: Record<SignInState['step'], readonly SignInStepView['step'][]> = {
  credentials: ['change_password', 'enrol_totp', 'totp', 'signed_in'],
  change_password: ['enrol_totp', 'totp', 'signed_in'],
  enrol_totp: ['signed_in'],
  totp: ['signed_in'],
  signed_in: [],
};

/** The state after a successful answer from the current step's route. */
export function advance(state: SignInState, answer: SignInStepView): SignInState {
  if (!ALLOWED[state.step].includes(answer.step)) {
    return { step: 'credentials', notice: 'unexpected' };
  }
  switch (answer.step) {
    case 'change_password':
      return { step: 'change_password' };
    case 'enrol_totp':
      return { step: 'enrol_totp', otpauthUri: answer.otpauthUri };
    case 'totp':
      return { step: 'totp' };
    case 'signed_in':
      return { step: 'signed_in' };
  }
}

/** Codes after which the current challenge is gone: start again from email and password. */
const RESTART_CODES: readonly ErrorCode[] = [
  ErrorCode.LOGIN_STATE_INVALID,
  ErrorCode.ACCOUNT_DISABLED,
];

/**
 * The state after an error from the current step's route. Wrong codes (MFA_INVALID), weak
 * passwords (PASSWORD_TOO_WEAK), rate limits and outages keep the step (the challenge stays
 * usable until it expires); a dead challenge restarts. On the credentials step nothing changes.
 */
export function fail(state: SignInState, code: ErrorCode | null): SignInState {
  if (state.step === 'credentials') return state;
  if (code !== null && RESTART_CODES.includes(code)) {
    return {
      step: 'credentials',
      notice: code === ErrorCode.LOGIN_STATE_INVALID ? 'expired' : null,
    };
  }
  return state;
}

/** The route each step posts to. */
export function stepPath(
  step: SignInState['step'],
): '/auth/login' | '/auth/password' | '/auth/mfa' | null {
  switch (step) {
    case 'credentials':
      return '/auth/login';
    case 'change_password':
      return '/auth/password';
    case 'enrol_totp':
    case 'totp':
      return '/auth/mfa';
    case 'signed_in':
      return null;
  }
}
