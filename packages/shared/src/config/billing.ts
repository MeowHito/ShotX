import { z } from 'zod';
import { PAYMENT_GATEWAYS, type PaymentGateway } from '../domain';
import { AWS_CLIENT_ENV, loadAwsClientConfig } from './aws-clients';
import { type Env, parseEnv } from './env';
import { GiB, int, intList, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from './fields';

// Plan prices and quotas live in the `plans` table (seeded by packages/db, edited by admins).
const billingEnvSchema = z.object({
  /** Prepaid periods PromptPay can buy, in months (spec: 1, 3, 6 or 12). */
  BILLING_PREPAID_MONTHS: intList(1, 36).default([1, 3, 6, 12]),
  /** VAT included in every price, in basis points (700 = 7%). Prices are VAT-inclusive. */
  VAT_RATE_BASIS_POINTS: int(0, 10_000).default(700),
  /** Alert admins when an account's monthly egress exceeds this multiple of its stored bytes. */
  EGRESS_ANOMALY_MULTIPLIER: z.coerce.number().positive().max(10_000).default(20),
  /**
   * The egress alert ignores months below this many bytes out, so tiny accounts (e.g. 1 MB stored,
   * 50 MB served) don't alert. Assumption: 10 GiB.
   */
  EGRESS_ANOMALY_MIN_BYTES: int(0, 1024 * GiB).default(10 * GiB),
  /**
   * How long a checkout (PromptPay QR or card page) can be paid, from its creation. While one is
   * pending the photographer can't start another (CHECKOUT_PENDING). Assumption: 15 minutes.
   */
  BILLING_CHECKOUT_EXPIRY_SECONDS: int(5 * SECONDS_PER_MINUTE, SECONDS_PER_DAY).default(
    15 * SECONDS_PER_MINUTE,
  ),
  /**
   * Smallest amount sent to a gateway, in satang (Omise's PromptPay minimum is 20 THB). An upgrade
   * whose prorated charge is below it is applied at once without a payment.
   */
  BILLING_MIN_CHARGE_SATANG: int(0, 100_000).default(2_000),
  /** Proration counts a month as this many days (prorateUpgrade). */
  BILLING_PRORATION_DAYS_PER_MONTH: int(28, 31).default(30),
  /**
   * Auto-renew charges per period: the first on the day of `period_end`, then one per daily run
   * during grace. After this many failures the subscription runs out like a prepaid one.
   */
  BILLING_RENEWAL_MAX_ATTEMPTS: int(1, 14).default(3),
  /** The daily job charges an auto-renew subscription when `period_end` is this close. */
  BILLING_RENEWAL_LEAD_SECONDS: int(0, 7 * SECONDS_PER_DAY).default(SECONDS_PER_DAY),
});

export interface BillingConfig {
  /** Sorted ascending. */
  prepaidMonths: number[];
  vatRateBasisPoints: number;
  egressAnomalyMultiplier: number;
  egressAnomalyMinBytes: number;
  checkoutExpirySeconds: number;
  minChargeSatang: number;
  prorationDaysPerMonth: number;
  renewal: { maxAttempts: number; leadSeconds: number };
}

/** Reads the billing tunables above (api and worker); every key has a default. */
export function loadBillingConfig(env: Env): BillingConfig {
  const e = parseEnv(billingEnvSchema, env, 'billing');
  return {
    prepaidMonths: [...e.BILLING_PREPAID_MONTHS].sort((a, b) => a - b),
    vatRateBasisPoints: e.VAT_RATE_BASIS_POINTS,
    egressAnomalyMultiplier: e.EGRESS_ANOMALY_MULTIPLIER,
    egressAnomalyMinBytes: e.EGRESS_ANOMALY_MIN_BYTES,
    checkoutExpirySeconds: e.BILLING_CHECKOUT_EXPIRY_SECONDS,
    minChargeSatang: e.BILLING_MIN_CHARGE_SATANG,
    prorationDaysPerMonth: e.BILLING_PRORATION_DAYS_PER_MONTH,
    renewal: {
      maxAttempts: e.BILLING_RENEWAL_MAX_ATTEMPTS,
      leadSeconds: e.BILLING_RENEWAL_LEAD_SECONDS,
    },
  };
}

// --- Billing mode (api, worker, web) --------------------------------------------------------------

/**
 * BILLING_MODE values (ADR 0010). Not to be confused with BILLING_MODES (`subscriptions.billing`:
 * prepaid or auto_renew).
 * - `offline` (default): no payment gateway. Photographers pay the owner in cash and an admin
 *   creates their account (and may record the payment, POST /admin/cash-payments). The billing
 *   routes answer NOT_FOUND (plans, checkout, payments, subscription, webhooks), the worker runs
 *   no subscription transitions, renewals or lifecycle emails, uploads and shares don't depend on
 *   a subscription (SUBSCRIPTION_INACTIVE never fires) and the studio hides plans and checkout.
 *   No loader requires a gateway setting or secret (loadPaymentGatewayConfig returns null).
 * - `gateway`: online billing as in Phase 4 (PAYMENT_GATEWAY and its secrets required). Its
 *   mapping of admin-created accounts to plans is decided by a later ADR.
 */
export const BILLING_OPERATING_MODES = ['offline', 'gateway'] as const;
export type BillingOperatingMode = (typeof BILLING_OPERATING_MODES)[number];

const billingModeEnvSchema = z.object({
  BILLING_MODE: z.enum(BILLING_OPERATING_MODES).default('offline'),
});

export interface BillingModeConfig {
  mode: BillingOperatingMode;
}

/** Reads BILLING_MODE (default `offline`). api and worker; needs no secret. */
export function loadBillingModeConfig(env: Env): BillingModeConfig {
  return { mode: parseEnv(billingModeEnvSchema, env, 'billing mode').BILLING_MODE };
}

// --- Payment gateway (api and worker) -------------------------------------------------------------

/**
 * Secret environment variables per gateway. infra injects them from Secrets Manager; nothing ever
 * logs them (error messages of the loader never repeat values). Only the selected gateway's
 * secrets are required.
 */
export const PAYMENT_GATEWAY_SECRET_ENV = {
  /** HMAC-SHA256 key of the fake gateway's webhook signature (fakeWebhookSignature). */
  fake: ['PAYMENT_FAKE_WEBHOOK_SECRET'],
  omise: ['PAYMENT_OMISE_PUBLIC_KEY', 'PAYMENT_OMISE_SECRET_KEY', 'PAYMENT_OMISE_WEBHOOK_SECRET'],
  '2c2p': ['PAYMENT_2C2P_MERCHANT_ID', 'PAYMENT_2C2P_SECRET_KEY'],
} as const satisfies Record<PaymentGateway, readonly string[]>;

/** Every secret name of PAYMENT_GATEWAY_SECRET_ENV. */
export const PAYMENT_GATEWAY_SECRET_NAMES: readonly string[] = Object.values(
  PAYMENT_GATEWAY_SECRET_ENV,
).flat();

/**
 * The deployment stage whose fake adapters are refused. Every ECS service runs with
 * NODE_ENV=production, including non-prod AWS stages that intentionally use the fake gateway and
 * email provider, so APP_STAGE decides, not NODE_ENV. infra's synth also fails a prod stage
 * configured with a fake adapter.
 */
export const PRODUCTION_APP_STAGE = 'prod';

/** APP_STAGE as these loaders read it: optional (unset locally and in tests). */
const appStage = z.string().optional();

const gatewayEnvSchema = z.object({
  APP_STAGE: appStage,
  /** The gateway new checkouts and renewals use. Default `fake`, which APP_STAGE=prod refuses. */
  PAYMENT_GATEWAY: z.enum(PAYMENT_GATEWAYS).default('fake'),
  /**
   * The fake gateway rejects webhooks whose signature timestamp is further than this from now
   * (replay protection). Real adapters use their gateway's own rule.
   */
  PAYMENT_WEBHOOK_TOLERANCE_SECONDS: int(30, SECONDS_PER_HOUR).default(5 * SECONDS_PER_MINUTE),
});

const secretValue = z.string({ error: 'must be a string' }).min(16, {
  error: 'must be at least 16 characters',
});

export interface PaymentGatewayConfig {
  gateway: PaymentGateway;
  webhookToleranceSeconds: number;
  /** The selected gateway's secrets by env name. Secret: never log this object. */
  secrets: Readonly<Record<string, string>>;
}

/**
 * Null with BILLING_MODE=offline (the default, ADR 0010): then nothing below is read or required,
 * not even on APP_STAGE=prod. With BILLING_MODE=gateway: reads PAYMENT_GATEWAY (default `fake`),
 * PAYMENT_WEBHOOK_TOLERANCE_SECONDS (300) and the selected gateway's secrets
 * (PAYMENT_GATEWAY_SECRET_ENV, each required, at least 16 characters), and throws when APP_STAGE
 * is `prod` and the gateway is `fake` (NODE_ENV doesn't matter).
 */
export function loadPaymentGatewayConfig(env: Env): PaymentGatewayConfig | null {
  if (loadBillingModeConfig(env).mode === 'offline') return null;
  const e = parseEnv(gatewayEnvSchema, env, 'payment gateway');
  if (e.APP_STAGE === PRODUCTION_APP_STAGE && e.PAYMENT_GATEWAY === 'fake') {
    throw new Error(
      'Invalid payment gateway configuration: PAYMENT_GATEWAY=fake on APP_STAGE=prod',
    );
  }
  const names = PAYMENT_GATEWAY_SECRET_ENV[e.PAYMENT_GATEWAY];
  const secretsSchema = z.object(Object.fromEntries(names.map((n) => [n, secretValue])));
  const secrets = parseEnv(secretsSchema, env, 'payment gateway secrets') as Record<string, string>;
  return {
    gateway: e.PAYMENT_GATEWAY,
    webhookToleranceSeconds: e.PAYMENT_WEBHOOK_TOLERANCE_SECONDS,
    secrets,
  };
}

// --- Email (api and worker) -----------------------------------------------------------------------

/**
 * EMAIL_PROVIDER values:
 * - `ses`: Amazon SES (client from SES_*, loadSesClientConfig).
 * - `fake`: records messages (tests and local runs). Refused on APP_STAGE=prod.
 * - `off` (the owner's launch decision of 2026-11-11): sending is switched off on purpose. Allowed
 *   on every stage, including prod. No SES_* setting is read or required, and neither is
 *   EMAIL_FROM_ADDRESS (EmailConfig.from is null). api and worker use OffEmailProvider
 *   (billing/email), which drops every message and logs only its template
 *   (DroppedEmailLogEntry), never the recipient, parameters or body.
 */
export const EMAIL_PROVIDERS = ['ses', 'fake', 'off'] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

/** The providers that actually render and send (or record) messages: everything but `off`. */
export type SendingEmailProviderName = Exclude<EmailProviderName, 'off'>;

const emailEnvSchema = z
  .object({
    APP_STAGE: appStage,
    /** `ses`, `fake` (refused on APP_STAGE=prod) or `off` (nothing is sent). Default `fake`. */
    EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('fake'),
    /**
     * Sender of every email, e.g. `no-reply@photos.example.com` (an SES-verified identity).
     * Required unless EMAIL_PROVIDER=off; with `off` it is optional, but validated when set.
     */
    EMAIL_FROM_ADDRESS: z.email({ error: 'must be an email address' }).max(254).optional(),
    /** Display name of the sender (Thai allowed). */
    EMAIL_FROM_NAME: z.string().trim().min(1).max(100).default('ShotX'),
  })
  .superRefine((e, ctx) => {
    if (e.EMAIL_PROVIDER !== 'off' && e.EMAIL_FROM_ADDRESS === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM_ADDRESS'],
        message: `is required unless EMAIL_PROVIDER=off`,
      });
    }
  });

/** The sender of every email. */
export interface EmailSender {
  address: string;
  name: string;
}

/** EMAIL_PROVIDER=ses or fake. */
export interface SendingEmailConfig {
  provider: SendingEmailProviderName;
  from: EmailSender;
}

/** EMAIL_PROVIDER=off: nothing is sent, so there is no sender. */
export interface OffEmailConfig {
  provider: 'off';
  from: null;
}

/** Narrow on `provider`: `from` is set for `ses` and `fake`, null for `off`. */
export type EmailConfig = SendingEmailConfig | OffEmailConfig;

/**
 * Reads EMAIL_PROVIDER (default `fake`), EMAIL_FROM_ADDRESS (required unless `off`) and
 * EMAIL_FROM_NAME (`ShotX`). Throws when APP_STAGE is `prod` and the provider is `fake` (NODE_ENV
 * doesn't matter); `off` is allowed on every stage. With `ses` and `fake` the SES_* values are
 * validated (format only); with `off` no SES_* setting is read. The SES client (with `ses`):
 * loadSesClientConfig (aws-clients.ts).
 */
export function loadEmailConfig(env: Env): EmailConfig {
  const e = parseEnv(emailEnvSchema, env, 'email');
  if (e.APP_STAGE === PRODUCTION_APP_STAGE && e.EMAIL_PROVIDER === 'fake') {
    throw new Error('Invalid email configuration: EMAIL_PROVIDER=fake on APP_STAGE=prod');
  }
  if (e.EMAIL_PROVIDER === 'off') return { provider: 'off', from: null };
  // Validates every SES_* value; the keys are enforced by loadSesClientConfig.
  loadAwsClientConfig(env, AWS_CLIENT_ENV.ses, 'email', { required: false });
  if (e.EMAIL_FROM_ADDRESS === undefined) {
    // Unreachable: the schema requires it unless `off`.
    throw new Error('Invalid email configuration: EMAIL_FROM_ADDRESS is required');
  }
  return {
    provider: e.EMAIL_PROVIDER,
    from: { address: e.EMAIL_FROM_ADDRESS, name: e.EMAIL_FROM_NAME },
  };
}
