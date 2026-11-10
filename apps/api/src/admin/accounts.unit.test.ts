import { randomUUID } from 'node:crypto';
import {
  allowedDuringPasswordChange,
  PASSWORD_CHANGE_CLAIM,
  PHOTOGRAPHER_ACCOUNT_ROUTES,
  ME_ROUTES,
  DRIVE_ROUTES,
} from '@shotx/shared';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { adminAccountKey } from '../auth/admin-sign-in';
import { assertPasswordPolicy, isCommonPassword } from '../auth/password-policy';
import { hashPassword } from '../auth/password';
import { photographerAccountKey } from '../auth/photographer-sign-in';
import { amrForSubject, ShotxTokenIssuer, ShotxTokenVerifier } from '../auth/shotx-tokens';
import { assertAccountActive } from '../auth/users';
import { uploadGate, uploadsBlockedUnder } from '../drive/account';
import { OFFLINE_ACCOUNTS_ENV, TestClock, testConfig } from '../testing/fakes';
import { shotxEnv } from '../testing/shotx-auth';
import { cashPaymentRequestSha256 } from './cash-payments.service';

// ADR 0010 rules that need no database: password policy, the restricted-session claim, account
// keys, the cash-payment request hash and the upload gate. Passwords here are made-up test values.

const CHEAP = { memoryKiB: 12_288, timeCost: 3, parallelism: 1 };

describe('password policy', () => {
  const policy = { minLength: 10, email: 'studio-a@example.test' };
  const reasonOf = async (password: string, extra: { currentHash?: string } = {}) => {
    try {
      await assertPasswordPolicy(password, { ...policy, ...extra });
      return null;
    } catch (error) {
      return (error as { code: string; details: { reason: string; minLength: number } }).details;
    }
  };

  it('refuses short, simple, email-like, common and unchanged passwords', async () => {
    expect(await reasonOf('fake-pw')).toEqual({ reason: 'too_short', minLength: 10 });
    expect(await reasonOf('zzzzzzzzzzzz')).toMatchObject({ reason: 'too_simple' });
    expect(await reasonOf('abcdefghijk')).toMatchObject({ reason: 'too_simple' });
    expect(await reasonOf('my-STUDIO-A-pw')).toMatchObject({ reason: 'contains_email' });
    expect(await reasonOf('QWERTY123456'.slice(0, 10))).toMatchObject({ reason: 'common' });
    const currentHash = await hashPassword('fake-Current-91', CHEAP);
    expect(await reasonOf('fake-Current-91', { currentHash })).toMatchObject({
      reason: 'same_as_current',
    });
    expect(await reasonOf('fake-Other-pw-92', { currentHash })).toBeNull();
  });

  it('matches the common list ignoring ASCII case only', () => {
    expect(isCommonPassword('PassWord123')).toBe(true);
    expect(isCommonPassword('fake-Unusual-pw-1')).toBe(false);
  });
});

describe('restricted photographer sessions (PASSWORD_CHANGE_CLAIM)', () => {
  const config = testConfig(shotxEnv());
  const auth = config.shotxAuth;
  if (auth === null) throw new Error('shotx auth is off');
  const clock = new TestClock();
  const issuer = new ShotxTokenIssuer(config.app.stage, auth, clock);
  const verifier = new ShotxTokenVerifier(config.app.stage, auth, clock);
  const subject = `password:${randomUUID()}`;

  it('password: subjects sign in with amr pwd', () => {
    expect(amrForSubject(subject)).toEqual(['pwd']);
  });

  it('carries the claim through issue and verify', async () => {
    const restricted = await issuer.accessToken('users', {
      subject,
      sessionId: randomUUID(),
      amr: ['pwd'],
      passwordChange: true,
    });
    expect(decodeJwt(restricted.token)[PASSWORD_CHANGE_CLAIM]).toBe(true);
    expect((await verifier.verify(restricted.token)).passwordChange).toBe(true);
    const normal = await issuer.accessToken('users', {
      subject,
      sessionId: randomUUID(),
      amr: ['pwd'],
    });
    expect(decodeJwt(normal.token)[PASSWORD_CHANGE_CLAIM]).toBeUndefined();
    expect((await verifier.verify(normal.token)).passwordChange).toBeUndefined();
  });

  it('refuses the claim on any other subject', async () => {
    await expect(
      issuer.accessToken('users', {
        subject: 'line:U123',
        sessionId: randomUUID(),
        amr: ['fed'],
        passwordChange: true,
      }),
    ).rejects.toThrow(/password sessions/);
  });

  it('allows only GET /me and the password change', () => {
    expect(allowedDuringPasswordChange(ME_ROUTES.get)).toBe(true);
    expect(allowedDuringPasswordChange(PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword)).toBe(true);
    expect(allowedDuringPasswordChange(DRIVE_ROUTES.usage)).toBe(false);
    expect(allowedDuringPasswordChange(ME_ROUTES.createViewerSession)).toBe(false);
  });
});

describe('account keys and status', () => {
  it('keys photographer and admin emails apart, ignoring ASCII case', () => {
    const secret = 'test-ip-hash-secret-0123456789abcdef';
    const a = photographerAccountKey(secret, ' Studio@Example.test ');
    expect(a).toBe(photographerAccountKey(secret, 'studio@example.test'));
    expect(a).not.toBe(adminAccountKey(secret, 'studio@example.test'));
    expect(a).not.toContain('studio');
  });

  it('ACCOUNT_DISABLED for disabled accounts', () => {
    expect(() => assertAccountActive({ status: 'disabled' })).toThrow(
      expect.objectContaining({ code: 'ACCOUNT_DISABLED' }),
    );
    expect(() => assertAccountActive({ status: 'active' })).not.toThrow();
  });
});

describe('cash payment request hash', () => {
  it('is canonical over the instant, key order and an absent note', () => {
    const id = randomUUID();
    const base = { photographerId: id, amountSatang: 149_000, paidAt: '2026-10-24T03:00:00Z' };
    const h = cashPaymentRequestSha256(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      cashPaymentRequestSha256({
        amountSatang: 149_000,
        paidAt: '2026-10-24T10:00:00.000+07:00',
        photographerId: id.toUpperCase(),
        note: undefined,
      }),
    ).toBe(h);
    expect(cashPaymentRequestSha256({ ...base, amountSatang: 149_001 })).not.toBe(h);
    expect(cashPaymentRequestSha256({ ...base, note: 'x' })).not.toBe(h);
  });
});

describe('upload gate (BILLING_MODE, STORAGE_QUOTA_ENFORCED)', () => {
  const state = { usedBytes: 10, reservedBytes: 0, quotaBytes: 10 };

  it('blocks nothing with the ADR 0010 defaults', () => {
    const gate = uploadGate(testConfig(OFFLINE_ACCOUNTS_ENV));
    expect(gate).toEqual({ subscription: false, quota: false });
    expect(uploadsBlockedUnder(gate, null, state)).toBeNull();
    expect(uploadsBlockedUnder(gate, 'expired', state)).toBeNull();
  });

  it('gates the subscription and the quota only when switched on', () => {
    expect(uploadsBlockedUnder({ subscription: true, quota: true }, null, state)).toBe(
      'SUBSCRIPTION_INACTIVE',
    );
    expect(uploadsBlockedUnder({ subscription: true, quota: true }, 'active', state)).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(uploadsBlockedUnder({ subscription: false, quota: true }, null, state)).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(uploadsBlockedUnder({ subscription: true, quota: false }, 'active', state)).toBeNull();
  });
});
