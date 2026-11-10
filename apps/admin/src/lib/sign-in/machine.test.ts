import { ADMIN_SIGN_IN_STEPS, ErrorCode } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { advance, fail, INITIAL_SIGN_IN_STATE, type SignInState, stepPath } from './machine';

const URI = 'otpauth://totp/ShotX:a%40b.co?secret=JBSWY3DPEHPK3PXP&issuer=ShotX';

describe('admin sign-in steps', () => {
  it('follows password → change password → enrol TOTP → signed in', () => {
    let state: SignInState = INITIAL_SIGN_IN_STATE;
    state = advance(state, { step: 'change_password' });
    expect(state).toEqual({ step: 'change_password' });
    state = advance(state, { step: 'enrol_totp', otpauthUri: URI });
    expect(state).toEqual({ step: 'enrol_totp', otpauthUri: URI });
    state = advance(state, { step: 'signed_in' });
    expect(state).toEqual({ step: 'signed_in' });
  });

  it('allows every first step the API can answer, and the code step directly', () => {
    for (const step of ADMIN_SIGN_IN_STEPS) {
      const answer = step === 'enrol_totp' ? { step, otpauthUri: URI } : { step };
      expect(advance(INITIAL_SIGN_IN_STATE, answer).step).toBe(step);
    }
    expect(advance({ step: 'totp' }, { step: 'signed_in' })).toEqual({ step: 'signed_in' });
  });

  it('never reaches signed_in without the code step', () => {
    expect(advance(INITIAL_SIGN_IN_STATE, { step: 'signed_in' })).toEqual({
      step: 'credentials',
      notice: 'unexpected',
    });
    expect(advance({ step: 'change_password' }, { step: 'signed_in' }).step).toBe('credentials');
    expect(advance({ step: 'change_password' }, { step: 'change_password' }).step).toBe(
      'credentials',
    );
    expect(advance({ step: 'totp' }, { step: 'enrol_totp', otpauthUri: URI }).step).toBe(
      'credentials',
    );
  });

  it('keeps the step on a wrong code or weak password, restarts on a dead challenge', () => {
    const enrol: SignInState = { step: 'enrol_totp', otpauthUri: URI };
    expect(fail(enrol, ErrorCode.MFA_INVALID)).toBe(enrol);
    expect(fail({ step: 'change_password' }, ErrorCode.PASSWORD_TOO_WEAK)).toEqual({
      step: 'change_password',
    });
    expect(fail({ step: 'totp' }, ErrorCode.RATE_LIMITED)).toEqual({ step: 'totp' });
    expect(fail({ step: 'totp' }, null)).toEqual({ step: 'totp' });
    // The enrolment secret is dropped with the restart.
    expect(fail(enrol, ErrorCode.LOGIN_STATE_INVALID)).toEqual({
      step: 'credentials',
      notice: 'expired',
    });
    expect(fail({ step: 'totp' }, ErrorCode.ACCOUNT_DISABLED)).toEqual({
      step: 'credentials',
      notice: null,
    });
    expect(fail(INITIAL_SIGN_IN_STATE, ErrorCode.INVALID_CREDENTIALS)).toBe(INITIAL_SIGN_IN_STATE);
  });

  it('posts each step to its route', () => {
    expect(stepPath('credentials')).toBe('/auth/login');
    expect(stepPath('change_password')).toBe('/auth/password');
    expect(stepPath('enrol_totp')).toBe('/auth/mfa');
    expect(stepPath('totp')).toBe('/auth/mfa');
    expect(stepPath('signed_in')).toBeNull();
  });
});
