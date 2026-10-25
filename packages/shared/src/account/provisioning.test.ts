import { describe, expect, it } from 'vitest';
import { newUserForIdentity, TRIAL_PLAN_CODE, trialSubscription } from './provisioning';

const sub = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('newUserForIdentity', () => {
  it('provisions users-pool identities as viewers and admins-pool identities as admins', () => {
    expect(
      newUserForIdentity({ pool: 'users', sub, email: 'a@example.com', name: 'สมชาย' }),
    ).toEqual({
      cognitoPool: 'users',
      cognitoSub: sub,
      role: 'user',
      email: 'a@example.com',
      name: 'สมชาย',
    });
    expect(newUserForIdentity({ pool: 'admins', sub, email: null, name: null }).role).toBe('admin');
  });

  it('rejects identities without a sub or with a bad email', () => {
    expect(() => newUserForIdentity({ pool: 'users', sub: '', email: null, name: null })).toThrow();
    expect(() =>
      newUserForIdentity({ pool: 'users', sub, email: 'not-an-email', name: null }),
    ).toThrow();
  });
});

describe('trialSubscription', () => {
  it('runs 14 days on the trial plan', () => {
    expect(TRIAL_PLAN_CODE).toBe('trial');
    expect(trialSubscription(new Date('2026-10-25T05:00:00Z'), 14)).toEqual({
      status: 'trial',
      billing: 'prepaid',
      periodEnd: new Date('2026-11-08T05:00:00Z'),
      cancelAtPeriodEnd: false,
    });
    expect(() => trialSubscription(new Date(), 0)).toThrow(RangeError);
  });
});
