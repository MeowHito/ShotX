import { describe, expect, it } from 'vitest';
import { loadAccountEmailConfig } from './account-email';

describe('loadAccountEmailConfig (ADR 0025)', () => {
  it('is off by default', () => {
    expect(loadAccountEmailConfig({})).toEqual({ provider: 'off', from: null });
  });

  it('reads SMTP: port 465 is TLS, From defaults to SMTP_USER', () => {
    const config = loadAccountEmailConfig({
      ACCOUNT_EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'snap@example.test',
      SMTP_PASSWORD: 'app-password',
    });
    expect(config).toEqual({
      provider: 'smtp',
      from: { address: 'snap@example.test', name: 'Snap' },
      smtp: {
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        user: 'snap@example.test',
        password: 'app-password',
      },
    });
    const starttls = loadAccountEmailConfig({
      ACCOUNT_EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_USER: 'resend',
      SMTP_PASSWORD: 'key',
      ACCOUNT_EMAIL_FROM_ADDRESS: 'no-reply@example.test',
    });
    expect(starttls).toMatchObject({
      from: { address: 'no-reply@example.test' },
      smtp: { port: 587, secure: false },
    });
  });

  it('refuses missing SMTP settings, a non-email user without a From, and fake on prod', () => {
    expect(() => loadAccountEmailConfig({ ACCOUNT_EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
    expect(() =>
      loadAccountEmailConfig({
        ACCOUNT_EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'h.example.test',
        SMTP_USER: 'resend',
        SMTP_PASSWORD: 'k',
      }),
    ).toThrow(/ACCOUNT_EMAIL_FROM_ADDRESS/);
    expect(() =>
      loadAccountEmailConfig({ ACCOUNT_EMAIL_PROVIDER: 'fake', APP_STAGE: 'prod' }),
    ).toThrow(/prod/);
    expect(loadAccountEmailConfig({ ACCOUNT_EMAIL_PROVIDER: 'fake' }).provider).toBe('fake');
  });
});
