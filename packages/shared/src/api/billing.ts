import { z } from 'zod';
import { amountBreakdownSchema, satangSchema } from '../billing/money';
import {
  AUTO_RENEW_MONTHS,
  BILLING_MODES,
  CHECKOUT_CHANGE_TYPES,
  CHECKOUT_STATUSES,
  PAYMENT_GATEWAYS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SUBSCRIPTION_STATUSES,
} from '../domain';
import { billingNoticeSchema, ERROR_CODES, type ErrorCode } from '../errors';
import { byteCountSchema, idSchema, isoDateTimeSchema } from './common';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from './share-page';

/**
 * Billing routes (Phase 4). Money is integer satang, VAT-inclusive, with the VAT split by
 * splitVat; the client never computes prices, it shows what the API returns. Plans come from the
 * `plans` table (admins edit them); BILLING_PREPAID_MONTHS and VAT_RATE_BASIS_POINTS from config.
 */

/** Card auto-renew intervals (AUTO_RENEW_MONTHS: 1 or 12). */
export const autoRenewMonthsSchema = z.literal(AUTO_RENEW_MONTHS);

/** Plan codes, as `plans_code_format` allows. */
export const planCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, {
  error: 'must be a plan code',
});

const planSummarySchema = z.object({
  code: planCodeSchema,
  name: z.string(),
  quotaBytes: byteCountSchema,
});
export type PlanSummary = z.output<typeof planSummarySchema>;

// --- GET /plans ------------------------------------------------------------------------------------

/** One purchasable plan with every price the studio shows. */
export const publicPlanSchema = planSummarySchema.extend({
  /** price_month_satang and price_year_satang, split. */
  month: amountBreakdownSchema,
  year: amountBreakdownSchema,
  /** One entry per BILLING_PREPAID_MONTHS value: periodPriceSatang(plan, months), split. */
  prepaid: z.array(
    z.object({ months: z.number().int().positive(), amount: amountBreakdownSchema }),
  ),
});
export type PublicPlan = z.output<typeof publicPlanSchema>;

/**
 * Active plans except the trial, by quota ascending. Public (no token): the pricing page uses it
 * too. Cacheable for a minute.
 */
export const plansResponseSchema = z.object({
  plans: z.array(publicPlanSchema),
  currency: z.literal('THB'),
  vatRateBasisPoints: z.number().int().min(0).max(10_000),
  /** BILLING_PREPAID_MONTHS: what PromptPay can buy. */
  prepaidMonths: z.array(z.number().int().positive()),
  /** AUTO_RENEW_MONTHS: card intervals. */
  autoRenewMonths: z.array(autoRenewMonthsSchema),
});
export type PlansResponse = z.output<typeof plansResponseSchema>;

// --- POST /billing/checkout --------------------------------------------------------------------------

/** `Idempotency-Key` is required (VALIDATION_FAILED at `headers.idempotency-key` without it). */
export const checkoutHeadersSchema = z.object({ [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema });

/**
 * How to pay:
 * - `promptpay`: a prepaid period of `months` (one of BILLING_PREPAID_MONTHS, checked by the API:
 *   PLAN_CHANGE_INVALID `months_not_offered`). `null` (or omitted) only for an upgrade, which
 *   charges proration only.
 * - `card`: charged now through the gateway's page and saved for auto-renew every `months`
 *   (1 or 12). A card downgrade of an auto-renew subscription charges nothing now.
 */
export const checkoutPaymentSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('promptpay'),
    months: z.number().int().min(1).max(36).nullable().default(null),
  }),
  z.strictObject({
    method: z.literal('card'),
    months: autoRenewMonthsSchema,
  }),
]);
export type CheckoutPaymentBody = z.input<typeof checkoutPaymentSchema>;

/**
 * Start a purchase. `changeType` is what the client expects (classifyCheckout): `new`, `renew`,
 * `upgrade` or `downgrade`; a different one is PLAN_CHANGE_INVALID with the expected type, so
 * nobody pays for a change they didn't see. Idempotent per photographer and Idempotency-Key: the
 * same key and body replays the first response (201); the same key with another body is
 * IDEMPOTENCY_KEY_REUSED; a key whose checkout expired unpaid is CHECKOUT_EXPIRED. While another
 * checkout is pending: CHECKOUT_PENDING.
 */
export const createCheckoutBodySchema = z.strictObject({
  planCode: planCodeSchema,
  changeType: z.enum(CHECKOUT_CHANGE_TYPES),
  payment: checkoutPaymentSchema,
});
export type CreateCheckoutBody = z.input<typeof createCheckoutBodySchema>;

/** What the browser does next to pay; null once nothing is left to pay. */
export const paymentActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('promptpay'),
    /** EMVCo payload of the QR (render it when there is no image). */
    qrPayload: z.string().min(1),
    /** The gateway's image, when it gave one (creation response only; null when polled). */
    qrImageDataUrl: z.string().startsWith('data:image/').nullable(),
    expiresAt: isoDateTimeSchema,
  }),
  z.object({
    kind: z.literal('card_redirect'),
    /** The gateway's hosted card page (https). It returns to BILLING_CARD_RETURN_PATH. */
    redirectUrl: z.url({ protocol: /^https$/ }),
    expiresAt: isoDateTimeSchema,
  }),
]);
export type PaymentAction = z.output<typeof paymentActionSchema>;

export const prorationSchema = z.object({
  remainingDays: z.number().int().nonnegative(),
  /** Before the BILLING_MIN_CHARGE_SATANG waiver: `amount.totalSatang` is 0 when waived. */
  amountSatang: satangSchema,
});

export const checkoutResponseSchema = z.object({
  checkoutId: idSchema,
  changeType: z.enum(CHECKOUT_CHANGE_TYPES),
  plan: planSummarySchema,
  /** `completed` right away when nothing is charged (waived upgrade, card downgrade). */
  status: z.enum(CHECKOUT_STATUSES),
  /** What is charged now, VAT split. All zero when nothing is charged. */
  amount: amountBreakdownSchema,
  /** Months bought (PromptPay) or the auto-renew interval (card); null for a PromptPay upgrade. */
  months: z.number().int().positive().nullable(),
  proration: prorationSchema.nullable(),
  /**
   * When the plan change takes effect once paid: now for new, renew and upgrade (renew extends
   * period_end), the current period_end for a downgrade.
   */
  effectiveAt: isoDateTimeSchema,
  /** The payment to poll (GET /billing/payments/:id); null when nothing is charged. */
  paymentId: idSchema.nullable(),
  /** Null when nothing is charged. */
  action: paymentActionSchema.nullable(),
  /** E.g. DOWNGRADE_EXCEEDS_QUOTA. */
  notices: z.array(billingNoticeSchema),
});
export type CheckoutResponse = z.output<typeof checkoutResponseSchema>;

// --- GET /billing/payments/:id ------------------------------------------------------------------------

/**
 * One payment of the caller (anyone else's: NOT_FOUND), for polling every few seconds after
 * checkout until `status` is final. `paid` means the change is applied (same transaction) unless
 * `checkout.status` is `failed` (PLAN_CHANGE_INVALID: an admin refunds it).
 */
export const paymentViewSchema = z.object({
  id: idSchema,
  status: z.enum(PAYMENT_STATUSES),
  method: z.enum(PAYMENT_METHODS),
  gateway: z.enum(PAYMENT_GATEWAYS),
  amount: amountBreakdownSchema,
  createdAt: isoDateTimeSchema,
  paidAt: isoDateTimeSchema.nullable(),
  /** `checkout` for a purchase, `renewal` for an auto-renew charge. */
  kind: z.enum(['checkout', 'renewal']),
  checkout: z
    .object({
      id: idSchema,
      changeType: z.enum(CHECKOUT_CHANGE_TYPES),
      plan: planSummarySchema,
      status: z.enum(CHECKOUT_STATUSES),
      expiresAt: isoDateTimeSchema,
      errorCode: z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]).nullable(),
    })
    .nullable(),
  /** While `pending` and not expired: how to pay (the QR payload again, or the card page). */
  action: paymentActionSchema.nullable(),
});
export type PaymentView = z.output<typeof paymentViewSchema>;

// --- GET /billing/subscription, POST /billing/subscription/cancel --------------------------------------

export const subscriptionViewSchema = z.object({
  id: idSchema,
  status: z.enum(SUBSCRIPTION_STATUSES),
  plan: planSummarySchema,
  billing: z.enum(BILLING_MODES),
  /** The card interval while auto-renew is on, else null. */
  autoRenewMonths: autoRenewMonthsSchema.nullable(),
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  /** True after POST /billing/subscription/cancel: auto-renew is off, access ends at periodEnd. */
  cancelAtPeriodEnd: z.boolean(),
  /** A scheduled downgrade. */
  pendingChange: z.object({ plan: planSummarySchema, effectiveAt: isoDateTimeSchema }).nullable(),
  /** Auto-renew only: when the card is charged next and how much (the plan due at periodEnd). */
  nextRenewal: z
    .object({
      at: isoDateTimeSchema,
      plan: planSummarySchema,
      months: autoRenewMonthsSchema,
      amount: amountBreakdownSchema,
    })
    .nullable(),
  /** subscriptionDeadlines: grace ends (expired) and purge, from periodEnd. */
  expiresAt: isoDateTimeSchema,
  purgeAt: isoDateTimeSchema,
});
export type SubscriptionView = z.output<typeof subscriptionViewSchema>;

/** The caller's latest subscription (null: never had one), with notices. */
export const subscriptionResponseSchema = z.object({
  subscription: subscriptionViewSchema.nullable(),
  /** DOWNGRADE_EXCEEDS_QUOTA while a pending downgrade's quota is below current usage. */
  notices: z.array(billingNoticeSchema),
});
export type SubscriptionResponse = z.output<typeof subscriptionResponseSchema>;

// --- POST /billing/webhooks/:gateway -------------------------------------------------------------------

/**
 * `:gateway` is the configured PAYMENT_GATEWAY; any other value is NOT_FOUND. The body is read raw
 * (at most API_JSON_BODY_MAX_BYTES) and verified before parsing.
 */
export const webhookParamsSchema = z.object({ gateway: z.enum(PAYMENT_GATEWAYS) });

/**
 * 200 once the signature is verified and the event stored (even if it was a duplicate, unknown or
 * unparseable: those are logged and alerted, not retried). 401 WEBHOOK_SIGNATURE_INVALID stores
 * nothing. 500 (the transaction failed) makes the gateway retry; processing is idempotent.
 */
export const webhookResponseSchema = z.object({ received: z.literal(true) });
