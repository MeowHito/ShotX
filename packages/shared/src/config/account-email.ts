import { z } from 'zod';
import { PRODUCTION_APP_STAGE } from './billing';
import { type Env, parseEnv } from './env';
import { int, secret } from './fields';

// --- Account email (api only, ADR 0025) ----------------------------------------------------------

/**
 * Emails about a person's own account (today: the photographer password-reset link), sent by the
 * api. Separate from the billing EMAIL_PROVIDER (receipts and subscription notices, still `off`),
 * so account mail can work over plain SMTP without SES:
 * - `smtp`: any SMTP server (Gmail with an app password, Google Workspace, Hostinger Mail, Resend,
 *   Brevo, ...). SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required; port 465 is implicit TLS,
 *   any other port must offer STARTTLS (required, never plain text).
 * - `fake`: records messages in memory (tests and local runs). Refused on APP_STAGE=prod.
 * - `off` (default): nothing can be sent, so "ลืมรหัสผ่าน" is unavailable (GET /auth/providers
 *   `passwordReset: false`) and photographers ask an admin to reset their password.
 */
export const ACCOUNT_EMAIL_PROVIDERS = ['smtp', 'fake', 'off'] as const;
export type AccountEmailProviderName = (typeof ACCOUNT_EMAIL_PROVIDERS)[number];

const accountEmailEnvSchema = z
  .object({
    /** Optional (unset locally and in tests). */
    APP_STAGE: z.string().optional(),
    ACCOUNT_EMAIL_PROVIDER: z.enum(ACCOUNT_EMAIL_PROVIDERS).default('off'),
    SMTP_HOST: z.string().trim().min(1).max(253).optional(),
    SMTP_PORT: int(1, 65_535).default(465),
    SMTP_USER: z.string().trim().min(1).max(254).optional(),
    /** Secret (an app password or an API key). */
    SMTP_PASSWORD: secret().optional(),
    /** The `From` address; default SMTP_USER when that is an email address. */
    ACCOUNT_EMAIL_FROM_ADDRESS: z.email({ error: 'must be an email address' }).max(254).optional(),
    /** The `From` display name (Thai allowed). */
    ACCOUNT_EMAIL_FROM_NAME: z.string().trim().min(1).max(100).default('Snap'),
  })
  .superRefine((e, ctx) => {
    if (e.ACCOUNT_EMAIL_PROVIDER !== 'smtp') return;
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const) {
      if (e[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required with ACCOUNT_EMAIL_PROVIDER=smtp',
        });
      }
    }
    if (
      e.ACCOUNT_EMAIL_FROM_ADDRESS === undefined &&
      e.SMTP_USER !== undefined &&
      !z.email().safeParse(e.SMTP_USER).success
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ACCOUNT_EMAIL_FROM_ADDRESS'],
        message: 'is required when SMTP_USER is not an email address',
      });
    }
  });

export interface AccountEmailFrom {
  address: string;
  name: string;
}

export interface SmtpAccountEmailConfig {
  provider: 'smtp';
  from: AccountEmailFrom;
  smtp: {
    host: string;
    port: number;
    /** Port 465: implicit TLS. Otherwise STARTTLS, required. */
    secure: boolean;
    user: string;
    /** Secret: never log. */
    password: string;
  };
}

export type AccountEmailConfig =
  | SmtpAccountEmailConfig
  | { provider: 'fake'; from: AccountEmailFrom }
  | { provider: 'off'; from: null };

/** Sender of `fake` messages when nothing else is set. */
const FAKE_FROM_ADDRESS = 'no-reply@snap.test';

/**
 * Reads ACCOUNT_EMAIL_PROVIDER (default `off`), SMTP_HOST, SMTP_PORT (465), SMTP_USER,
 * SMTP_PASSWORD, ACCOUNT_EMAIL_FROM_ADDRESS (default SMTP_USER) and ACCOUNT_EMAIL_FROM_NAME
 * (`Snap`). Throws on `fake` with APP_STAGE=prod.
 */
export function loadAccountEmailConfig(env: Env): AccountEmailConfig {
  const e = parseEnv(accountEmailEnvSchema, env, 'account email');
  if (e.APP_STAGE === PRODUCTION_APP_STAGE && e.ACCOUNT_EMAIL_PROVIDER === 'fake') {
    throw new Error(
      'Invalid account email configuration: ACCOUNT_EMAIL_PROVIDER=fake on APP_STAGE=prod',
    );
  }
  const name = e.ACCOUNT_EMAIL_FROM_NAME;
  switch (e.ACCOUNT_EMAIL_PROVIDER) {
    case 'off':
      return { provider: 'off', from: null };
    case 'fake':
      return {
        provider: 'fake',
        from: { address: e.ACCOUNT_EMAIL_FROM_ADDRESS ?? FAKE_FROM_ADDRESS, name },
      };
    case 'smtp': {
      const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASSWORD: password } = e;
      if (host === undefined || user === undefined || password === undefined) {
        // Unreachable: the schema requires them with `smtp`.
        throw new Error('Invalid account email configuration: SMTP settings are missing');
      }
      return {
        provider: 'smtp',
        from: { address: e.ACCOUNT_EMAIL_FROM_ADDRESS ?? user, name },
        smtp: { host, port: e.SMTP_PORT, secure: e.SMTP_PORT === 465, user, password },
      };
    }
  }
}
