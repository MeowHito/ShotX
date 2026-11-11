import { z } from 'zod';
import { CHECKOUT_CHANGE_TYPES, PAYMENT_METHODS } from '../domain';
import { satangSchema } from './money';

/**
 * The email adapter. `SesEmailProvider` (placeholder until SES is set up) and `FakeEmailProvider`
 * (records messages, for tests and local runs) live in the api and worker; OffEmailProvider
 * (EMAIL_PROVIDER=off: drops every message) lives here so both use the same one. Selected by
 * EMAIL_PROVIDER (loadEmailConfig). Shared defines the templates, their i18n keys and
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

/** What a provider answers for one message it accepted. */
export interface EmailSendResult {
  messageId: string;
  /**
   * True when the message was dropped on purpose (EMAIL_PROVIDER=off), not sent. Callers treat it
   * like a success (notices and receipts are marked done, so nothing old is sent once email is
   * switched on); absent or false for every real send.
   */
  dropped?: boolean;
}

export interface EmailProvider {
  /** Sends one message. Throws on failure; the caller logs the notice only after success. */
  send<T extends EmailTemplate>(message: EmailMessage<T>): Promise<EmailSendResult>;
}

/** `messageId` of every message OffEmailProvider drops. */
export const DROPPED_EMAIL_MESSAGE_ID = 'email-off';

/**
 * The one log entry OffEmailProvider writes per dropped message: the template only. Never the
 * recipient, parameters, rendered text or idempotency key (which can contain account ids).
 */
export interface DroppedEmailLogEntry {
  event: 'email.dropped';
  provider: 'off';
  template: EmailTemplate;
}

/** The log entry of a dropped message (reads `template` only). */
export function droppedEmailLogEntry(
  message: Pick<EmailMessage, 'template'>,
): DroppedEmailLogEntry {
  return { event: 'email.dropped', provider: 'off', template: message.template };
}

/**
 * EMAIL_PROVIDER=off (allowed on every stage, prod included): accepts every message without
 * rendering or sending it, and calls `log` with droppedEmailLogEntry only. api and worker pass
 * their logger, e.g. `new OffEmailProvider((entry) => logger.info(entry))`. Never rejects (not
 * even when `log` throws), so callers' retry paths stay idle.
 */
export class OffEmailProvider implements EmailProvider {
  constructor(private readonly log: (entry: DroppedEmailLogEntry) => void) {}

  send<T extends EmailTemplate>(message: EmailMessage<T>): Promise<EmailSendResult> {
    try {
      this.log(droppedEmailLogEntry(message));
    } catch {
      // A failing logger must not turn a deliberate no-op into a send failure.
    }
    return Promise.resolve({ messageId: DROPPED_EMAIL_MESSAGE_ID, dropped: true });
  }
}

/** Path of the studio billing page that emails link to (PUBLIC_BASE_URL + this). */
export const BILLING_PAGE_PATH = '/studio/billing';
