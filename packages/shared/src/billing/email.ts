import { z } from 'zod';
import { CHECKOUT_CHANGE_TYPES, PAYMENT_METHODS } from '../domain';
import { satangSchema } from './money';

/**
 * The email adapter. Types only: `SesEmailProvider` (placeholder until SES is set up) and
 * `FakeEmailProvider` (records messages, for tests and local runs) live in the api and worker,
 * selected by EMAIL_PROVIDER (loadEmailConfig). Shared defines the templates, their i18n keys and
 * their parameters; the Thai subject and body text live in the api/worker messages (`th`), keyed
 * by EMAIL_TEMPLATES[template].subjectKey / bodyKey, so every template must have both strings.
 * Amounts are satang (render as THB with 2 decimals), times are ISO 8601 (render in Asia/Bangkok).
 * Parameters never contain card data, biometrics or anything about viewers.
 */

const isoDateTime = z.iso.datetime({ offset: true });
const url = z.url();

export const EMAIL_TEMPLATE_PARAMS = {
  /** T-14/T-7/T-1 before period_end (dueRenewalReminder). */
  renewal_reminder: z.strictObject({
    planName: z.string().min(1),
    periodEnd: isoDateTime,
    daysBefore: z.number().int().positive(),
    /** True: "your card will be charged"; false: "renew to keep uploading". */
    autoRenew: z.boolean(),
    /** The auto-renew charge; null for prepaid. */
    renewalAmountSatang: satangSchema.nullable(),
    billingUrl: url,
  }),
  /** After a payment is applied (logged by payments.receipt_sent_at). Not a full tax invoice. */
  payment_receipt: z.strictObject({
    paymentId: z.uuid(),
    planName: z.string().min(1),
    changeType: z.enum(CHECKOUT_CHANGE_TYPES).nullable(),
    method: z.enum(PAYMENT_METHODS),
    totalSatang: satangSchema,
    vatSatang: satangSchema,
    netSatang: satangSchema,
    paidAt: isoDateTime,
    periodEnd: isoDateTime,
    billingUrl: url,
  }),
  /** The period ended: uploads blocked, shares still work until graceEndsAt. */
  grace_started: z.strictObject({ graceEndsAt: isoDateTime, billingUrl: url }),
  /** Grace is over: shares show "ลิงก์นี้หมดอายุ"; files are deleted at purgeAt. */
  subscription_expired: z.strictObject({ purgeAt: isoDateTime, billingUrl: url }),
  /** SUBSCRIPTION_PURGE_WARNING_DAYS before the purge. */
  purge_warning: z.strictObject({ purgeAt: isoDateTime, billingUrl: url }),
} as const;

export type EmailTemplate = keyof typeof EMAIL_TEMPLATE_PARAMS;
export const EMAIL_TEMPLATE_NAMES = Object.keys(EMAIL_TEMPLATE_PARAMS) as readonly EmailTemplate[];
export type EmailTemplateParams<T extends EmailTemplate> = z.input<
  (typeof EMAIL_TEMPLATE_PARAMS)[T]
>;

/** i18n keys of each template's Thai subject and body (the text lives in the api/worker). */
export const EMAIL_TEMPLATES = {
  renewal_reminder: {
    subjectKey: 'email.renewalReminder.subject',
    bodyKey: 'email.renewalReminder.body',
  },
  payment_receipt: {
    subjectKey: 'email.paymentReceipt.subject',
    bodyKey: 'email.paymentReceipt.body',
  },
  grace_started: { subjectKey: 'email.graceStarted.subject', bodyKey: 'email.graceStarted.body' },
  subscription_expired: {
    subjectKey: 'email.subscriptionExpired.subject',
    bodyKey: 'email.subscriptionExpired.body',
  },
  purge_warning: { subjectKey: 'email.purgeWarning.subject', bodyKey: 'email.purgeWarning.body' },
} as const satisfies Record<EmailTemplate, { subjectKey: string; bodyKey: string }>;

/** One email to send. The provider renders `template` with `params` in `locale`. */
export interface EmailMessage<T extends EmailTemplate = EmailTemplate> {
  to: string;
  template: T;
  locale: 'th';
  params: EmailTemplateParams<T>;
  /**
   * Stable per logical email (e.g. `notice:{subscriptionId}:{kind}:{periodEnd}:{days}` or
   * `receipt:{paymentId}`); providers that support it dedupe on it.
   */
  idempotencyKey: string;
}

export interface EmailProvider {
  /** Sends one message. Throws on failure; the caller logs the notice only after success. */
  send<T extends EmailTemplate>(message: EmailMessage<T>): Promise<{ messageId: string }>;
}

/** Path of the studio billing page that emails link to (PUBLIC_BASE_URL + this). */
export const BILLING_PAGE_PATH = '/studio/billing';
