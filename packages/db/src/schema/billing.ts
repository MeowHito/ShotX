import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { plans, subscriptions, users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import {
  authPool,
  billingActor,
  checkoutChangeType,
  checkoutStatus,
  paymentEventType,
  paymentMethod,
  paymentStatus,
  subscriptionEventType,
  subscriptionNoticeKind,
  subscriptionStatus,
} from './enums';

// Billing (Phase 4, migration 0004). The rules and the transaction patterns (checkout, webhook,
// daily job) are documented in @shotx/shared billing/subscription. Money is integer satang,
// VAT-inclusive; `vat_satang` is splitVat's VAT of `amount_satang`. Card data is never stored:
// only the gateway's reference to a saved method (`subscriptions.payment_method_ref`).

const gatewayFormat = (column: unknown) => sql`${column} ~ '^[a-z0-9_]{1,32}$'`;

/**
 * One purchase attempt (POST /billing/checkout), and the idempotency store of that route: unique
 * per (photographer_id, idempotency_key), with `request_sha256` (hex SHA-256 of the canonical
 * request: plan code, change type, payment) to tell a replay from a reused key. At most one
 * `pending` checkout per photographer (CHECKOUT_PENDING); before inserting, the API marks the
 * photographer's pending checkouts past `expires_at` as `expired`.
 *
 * `subscription_id` is the row the change applies to (null: none yet, or the latest is purged;
 * the payment then creates a row). `amount_satang` 0 means nothing is charged (a waived upgrade
 * or a card downgrade): the change was applied at creation and the status is `completed`.
 * `qr_payload` / `redirect_url` let a reloaded page show the QR or card page again.
 */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: id(),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    changeType: checkoutChangeType('change_type').notNull(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    fromPlanId: uuid('from_plan_id').references(() => plans.id),
    method: paymentMethod('method').notNull(),
    /** Months bought (PromptPay) or the auto-renew interval (card); null for a PromptPay upgrade. */
    months: integer('months'),
    amountSatang: integer('amount_satang').notNull(),
    vatSatang: integer('vat_satang').notNull(),
    /** Upgrades: prorateUpgrade before the minimum-charge waiver. */
    prorationSatang: integer('proration_satang'),
    prorationDays: integer('proration_days'),
    /** The gateway that collects it; null when nothing is charged. */
    gateway: text('gateway'),
    status: checkoutStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestSha256: text('request_sha256').notNull(),
    qrPayload: text('qr_payload'),
    redirectUrl: text('redirect_url'),
    /** Why it failed (an ErrorCode, e.g. PLAN_CHANGE_INVALID when a late payment can't apply). */
    errorCode: text('error_code'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
    /** When it became completed, failed or expired. */
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [
    unique('checkout_sessions_idempotency_unique').on(t.photographerId, t.idempotencyKey),
    uniqueIndex('checkout_sessions_one_pending_per_photographer')
      .on(t.photographerId)
      .where(sql`${t.status} = 'pending'`),
    index('checkout_sessions_photographer_created_idx').on(t.photographerId, t.createdAt),
    index('checkout_sessions_pending_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    check('checkout_sessions_idempotency_key_format', sql`${t.idempotencyKey} ~ '^[!-~]{1,255}$'`),
    check('checkout_sessions_request_sha256_hex', sql`${t.requestSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'checkout_sessions_amounts_valid',
      sql`${t.amountSatang} >= 0 AND ${t.vatSatang} >= 0 AND ${t.vatSatang} <= ${t.amountSatang} AND (${t.prorationSatang} IS NULL OR ${t.prorationSatang} >= 0) AND (${t.prorationDays} IS NULL OR ${t.prorationDays} >= 0)`,
    ),
    check(
      'checkout_sessions_proration_for_upgrades',
      sql`(${t.changeType} = 'upgrade') = (${t.prorationSatang} IS NOT NULL) AND (${t.prorationSatang} IS NULL) = (${t.prorationDays} IS NULL)`,
    ),
    check(
      'checkout_sessions_months_valid',
      sql`${t.months} IS NULL OR ${t.months} BETWEEN 1 AND 36`,
    ),
    check(
      'checkout_sessions_months_required',
      sql`${t.months} IS NOT NULL OR (${t.changeType} = 'upgrade' AND ${t.method} = 'promptpay')`,
    ),
    check(
      'checkout_sessions_gateway_iff_charged',
      sql`(${t.amountSatang} > 0) = (${t.gateway} IS NOT NULL) AND (${t.gateway} IS NULL OR ${gatewayFormat(t.gateway)})`,
    ),
    check(
      'checkout_sessions_free_is_completed',
      sql`${t.amountSatang} > 0 OR ${t.status} = 'completed'`,
    ),
    check(
      'checkout_sessions_finished_iff_final',
      sql`(${t.status} = 'pending') = (${t.finishedAt} IS NULL)`,
    ),
    check(
      'checkout_sessions_error_iff_failed',
      sql`(${t.status} = 'failed') = (${t.errorCode} IS NOT NULL) AND (${t.errorCode} IS NULL OR ${t.errorCode} ~ '^[A-Z][A-Z0-9_]{0,63}$')`,
    ),
  ],
);

/**
 * Gateway payments. Webhooks find them by (gateway, gateway_ref), the UNIQUE key, which makes
 * them idempotent. `amount_satang` is the VAT-inclusive total and `vat_satang` the VAT part of it.
 *
 * Migration 0004: `photographer_id` (backfilled from the subscription); `subscription_id` is
 * nullable (a `new` checkout without a reusable subscription row gets one when it is applied);
 * a payment is either a checkout's (`checkout_id`, at most one per checkout) or an auto-renew
 * charge (`renewal_period_end`, the period_end it extends), never both (older rows have neither).
 * `payments_one_open_renewal` stops a second charge for the same period while one is pending or
 * paid; failed attempts are counted against BILLING_RENEWAL_MAX_ATTEMPTS.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    checkoutId: uuid('checkout_id').references(() => checkoutSessions.id),
    renewalPeriodEnd: timestamptz('renewal_period_end'),
    amountSatang: integer('amount_satang').notNull(),
    vatSatang: integer('vat_satang').notNull(),
    method: paymentMethod('method').notNull(),
    /** A PAYMENT_GATEWAYS value: `fake`, `omise`, `2c2p`. */
    gateway: text('gateway').notNull(),
    /** The gateway's id for the charge. */
    gatewayRef: text('gateway_ref').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    /** The gateway's failure code of a failed charge. */
    failureCode: text('failure_code'),
    paidAt: timestamptz('paid_at'),
    refundedAt: timestamptz('refunded_at'),
    /** When the payment_receipt email went out (sent once). */
    receiptSentAt: timestamptz('receipt_sent_at'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('payments_gateway_ref_unique').on(t.gateway, t.gatewayRef),
    index('payments_subscription_idx').on(t.subscriptionId),
    index('payments_photographer_created_idx').on(t.photographerId, t.createdAt),
    uniqueIndex('payments_checkout_unique')
      .on(t.checkoutId)
      .where(sql`${t.checkoutId} IS NOT NULL`),
    uniqueIndex('payments_one_open_renewal')
      .on(t.subscriptionId, t.renewalPeriodEnd)
      .where(sql`${t.renewalPeriodEnd} IS NOT NULL AND ${t.status} IN ('pending', 'paid')`),
    check('payments_amount_nonnegative', sql`${t.amountSatang} >= 0`),
    check(
      'payments_vat_within_amount',
      sql`${t.vatSatang} >= 0 AND ${t.vatSatang} <= ${t.amountSatang}`,
    ),
    check('payments_paid_has_paid_at', sql`${t.status} <> 'paid' OR ${t.paidAt} IS NOT NULL`),
    check(
      'payments_refunded_has_refunded_at',
      sql`(${t.status} = 'refunded') = (${t.refundedAt} IS NOT NULL)`,
    ),
    check('payments_gateway_format', gatewayFormat(t.gateway)),
    check('payments_gateway_ref_not_empty', sql`length(${t.gatewayRef}) > 0`),
    check(
      'payments_checkout_or_renewal',
      sql`${t.checkoutId} IS NULL OR ${t.renewalPeriodEnd} IS NULL`,
    ),
    check(
      'payments_renewal_has_subscription',
      sql`${t.renewalPeriodEnd} IS NULL OR ${t.subscriptionId} IS NOT NULL`,
    ),
  ],
);

/**
 * Every verified webhook, stored before it is applied (raw body hash only: payloads can contain
 * personal data). Deduplicated by (gateway, event_ref): the gateway's event id, or
 * `{gateway_ref}:{type}` when it has none, or `sha256:{payload_sha256}` for a body that could not
 * be parsed. Not unique by (gateway, gateway_ref): one charge has several events over its life
 * (paid, then refunded); `payments` is the table unique by (gateway, gateway_ref).
 *
 * `processed_at` is set in the transaction that applied it (or decided to ignore it);
 * `error_code` (`unknown_payment`, `amount_mismatch`, `unparseable`, ...) marks events an
 * operator must look at, together with `processed_at IS NULL` rows older than a few minutes.
 */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: id(),
    gateway: text('gateway').notNull(),
    eventRef: text('event_ref').notNull(),
    /** Null for an unparseable body. */
    gatewayRef: text('gateway_ref'),
    type: paymentEventType('type'),
    amountSatang: integer('amount_satang'),
    payloadSha256: text('payload_sha256').notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    verifiedAt: timestamptz('verified_at').notNull(),
    processedAt: timestamptz('processed_at'),
    paymentId: uuid('payment_id').references(() => payments.id),
    errorCode: text('error_code'),
  },
  (t) => [
    unique('payment_webhook_events_event_unique').on(t.gateway, t.eventRef),
    index('payment_webhook_events_charge_idx').on(t.gateway, t.gatewayRef),
    index('payment_webhook_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
    check('payment_webhook_events_gateway_format', gatewayFormat(t.gateway)),
    check('payment_webhook_events_event_ref_valid', sql`length(${t.eventRef}) BETWEEN 1 AND 255`),
    check('payment_webhook_events_payload_sha256_hex', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'payment_webhook_events_amount_nonnegative',
      sql`${t.amountSatang} IS NULL OR ${t.amountSatang} >= 0`,
    ),
    check(
      'payment_webhook_events_error_code_format',
      sql`${t.errorCode} IS NULL OR ${t.errorCode} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
  ],
);

/**
 * Lifecycle emails sent by the daily job, at most once each: the insert of this row and the send
 * decide it (`INSERT ... ON CONFLICT DO NOTHING RETURNING`, send, and on a send failure delete
 * the row so the next run retries). `days_before` is the reminder day (T-14/T-7/T-1), the purge
 * warning's SUBSCRIPTION_PURGE_WARNING_DAYS, and 0 for grace_started and expired. `period_end` is
 * the period it is about, so a renewed period gets its own reminders.
 */
export const subscriptionNotices = pgTable(
  'subscription_notices',
  {
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    kind: subscriptionNoticeKind('kind').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    daysBefore: integer('days_before').notNull(),
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'subscription_notices_pkey',
      columns: [t.subscriptionId, t.kind, t.periodEnd, t.daysBefore],
    }),
    check('subscription_notices_days_valid', sql`${t.daysBefore} BETWEEN 0 AND 60`),
  ],
);

/**
 * Audit trail of every subscription change, one row per SUBSCRIPTION_EVENT_TYPES event, inserted
 * in the transaction that makes the change. Append-only by convention. `meta` holds codes and
 * counts only (e.g. `{ "failureCode": "insufficient_fund" }`), never card data.
 */
export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: id(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id),
    type: subscriptionEventType('type').notNull(),
    actor: billingActor('actor').notNull(),
    /** The admin or photographer who acted; null for the gateway and the system. */
    actorUserId: uuid('actor_user_id').references(() => users.id),
    fromStatus: subscriptionStatus('from_status'),
    toStatus: subscriptionStatus('to_status').notNull(),
    fromPlanId: uuid('from_plan_id').references(() => plans.id),
    toPlanId: uuid('to_plan_id')
      .notNull()
      .references(() => plans.id),
    periodEndBefore: timestamptz('period_end_before'),
    periodEndAfter: timestamptz('period_end_after').notNull(),
    paymentId: uuid('payment_id').references(() => payments.id),
    checkoutId: uuid('checkout_id').references(() => checkoutSessions.id),
    meta: jsonb('meta').$type<Record<string, string | number | boolean>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('subscription_events_subscription_created_idx').on(t.subscriptionId, t.createdAt),
    index('subscription_events_photographer_created_idx').on(t.photographerId, t.createdAt),
    index('subscription_events_type_created_idx').on(t.type, t.createdAt),
    check(
      'subscription_events_actor_user',
      sql`(${t.actor} IN ('photographer', 'admin')) = (${t.actorUserId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Cash payments an admin records (migration 0011, ADR 0010; optional, for the owner's own
 * bookkeeping). A ledger: rows are never updated or deleted, and each is inserted in one
 * transaction with its `admin.cash_payment.created` audit_log row. Not a gateway payment: no VAT
 * split, no subscription. Money is integer satang.
 *
 * - (photographer_id, photographer_pool) references users (id, auth_pool) with the pool fixed to
 *   `users`, and (recorded_by_id, recorded_by_pool) with `admins`: the payer is never an admin and
 *   the recorder always is (role `admin` iff admins pool). The api also checks the payer's role is
 *   `photographer` (NOT_FOUND otherwise).
 * - `paid_at`: when the cash changed hands (the admin enters it), at most a day after the row was
 *   recorded (`cash_payments_paid_at_not_future`).
 * - `note`: 1-500 characters or null.
 * - POST /admin/cash-payments is idempotent per recording admin and `Idempotency-Key`
 *   (`cash_payments_idempotency_unique`), with `request_sha256` (hex SHA-256 of the canonical
 *   request) telling a replay from a reused key (IDEMPOTENCY_KEY_REUSED).
 */
export const cashPayments = pgTable(
  'cash_payments',
  {
    id: id(),
    photographerId: uuid('photographer_id').notNull(),
    photographerPool: authPool('photographer_pool').notNull().default('users'),
    amountSatang: integer('amount_satang').notNull(),
    paidAt: timestamptz('paid_at').notNull(),
    note: text('note'),
    recordedById: uuid('recorded_by_id').notNull(),
    recordedByPool: authPool('recorded_by_pool').notNull().default('admins'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestSha256: text('request_sha256').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'cash_payments_photographer_fk',
      columns: [t.photographerId, t.photographerPool],
      foreignColumns: [users.id, users.authPool],
    }),
    foreignKey({
      name: 'cash_payments_recorded_by_admin_fk',
      columns: [t.recordedById, t.recordedByPool],
      foreignColumns: [users.id, users.authPool],
    }),
    unique('cash_payments_idempotency_unique').on(t.recordedById, t.idempotencyKey),
    index('cash_payments_photographer_paid_idx').on(t.photographerId, t.paidAt.desc(), t.id.desc()),
    index('cash_payments_paid_idx').on(t.paidAt.desc(), t.id.desc()),
    check('cash_payments_photographer_pool', sql`${t.photographerPool} = 'users'`),
    check('cash_payments_recorded_by_pool', sql`${t.recordedByPool} = 'admins'`),
    check('cash_payments_amount_positive', sql`${t.amountSatang} > 0`),
    check(
      'cash_payments_note_length',
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`,
    ),
    check(
      'cash_payments_paid_at_not_future',
      sql`${t.paidAt} <= ${t.createdAt} + interval '1 day'`,
    ),
    check('cash_payments_idempotency_key_format', sql`${t.idempotencyKey} ~ '^[!-~]{1,255}$'`),
    check('cash_payments_request_sha256_hex', sql`${t.requestSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
