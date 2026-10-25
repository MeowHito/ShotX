import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import {
  authPool,
  billingMode,
  paymentMethod,
  paymentStatus,
  subscriptionStatus,
  userRole,
} from './enums';

/**
 * Everyone who signs in: photographers, viewers (role `user`) and admins.
 *
 * Identity is the pair (cognito_pool, cognito_sub): a `sub` is only unique within its Cognito user
 * pool, and the API resolves the pool from the token it verified, never from the request. The
 * CHECK ties `admin` to the admins pool both ways, so a users-pool identity can never be an admin
 * and an admins-pool identity is always one.
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    /** Optional: LINE only shares an email after LINE approves the email permission. */
    email: text('email'),
    name: text('name'),
    role: userRole('role').notNull().default('user'),
    cognitoPool: authPool('cognito_pool').notNull(),
    cognitoSub: text('cognito_sub').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('users_cognito_identity_unique').on(t.cognitoPool, t.cognitoSub),
    check(
      'users_admin_iff_admins_pool',
      sql`(${t.role} = 'admin') = (${t.cognitoPool} = 'admins')`,
    ),
    check('users_cognito_sub_not_empty', sql`length(${t.cognitoSub}) > 0`),
  ],
);

/**
 * Storage plans. Prices include 7% VAT and are integer satang (1 THB = 100 satang). The trial is
 * a plan row too: `trial_days` is set only on it, and its prices are 0.
 */
export const plans = pgTable(
  'plans',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull(),
    priceMonthSatang: integer('price_month_satang').notNull(),
    priceYearSatang: integer('price_year_satang').notNull(),
    trialDays: integer('trial_days'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [
    unique('plans_code_unique').on(t.code),
    check('plans_code_format', sql`${t.code} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check('plans_quota_positive', sql`${t.quotaBytes} > 0`),
    check(
      'plans_prices_nonnegative',
      sql`${t.priceMonthSatang} >= 0 AND ${t.priceYearSatang} >= 0`,
    ),
    check('plans_trial_days_positive', sql`${t.trialDays} IS NULL OR ${t.trialDays} > 0`),
  ],
);

/**
 * A photographer's subscription. At most one is live (trial, active or grace) per photographer;
 * expired and purged rows stay as history.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatus('status').notNull(),
    billing: billingMode('billing').notNull().default('prepaid'),
    periodEnd: timestamptz('period_end').notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('subscriptions_one_live_per_photographer')
      .on(t.photographerId)
      .where(sql`${t.status} IN ('trial', 'active', 'grace')`),
    index('subscriptions_photographer_idx').on(t.photographerId),
    index('subscriptions_status_period_end_idx').on(t.status, t.periodEnd),
  ],
);

/**
 * Gateway payments. Webhooks upsert by (gateway, gateway_ref), which makes them idempotent.
 * `amount_satang` is the VAT-inclusive total and `vat_satang` the VAT part of it.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    amountSatang: integer('amount_satang').notNull(),
    vatSatang: integer('vat_satang').notNull(),
    method: paymentMethod('method').notNull(),
    /** Gateway name, e.g. `omise`, `2c2p`, `stripe`. */
    gateway: text('gateway').notNull(),
    /** The gateway's id for the charge. */
    gatewayRef: text('gateway_ref').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    paidAt: timestamptz('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('payments_gateway_ref_unique').on(t.gateway, t.gatewayRef),
    index('payments_subscription_idx').on(t.subscriptionId),
    check('payments_amount_nonnegative', sql`${t.amountSatang} >= 0`),
    check(
      'payments_vat_within_amount',
      sql`${t.vatSatang} >= 0 AND ${t.vatSatang} <= ${t.amountSatang}`,
    ),
    check('payments_paid_has_paid_at', sql`${t.status} <> 'paid' OR ${t.paidAt} IS NOT NULL`),
    check('payments_gateway_format', sql`${t.gateway} ~ '^[a-z0-9_]{1,32}$'`),
    check('payments_gateway_ref_not_empty', sql`length(${t.gatewayRef}) > 0`),
  ],
);

/**
 * Quota accounting per photographer, in bytes of originals (trash included). Uploads reserve
 * first; the worker moves bytes from reserved to used once the object is verified.
 */
export const storageUsage = pgTable(
  'storage_usage',
  {
    photographerId: uuid('photographer_id')
      .primaryKey()
      .references(() => users.id),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    reservedBytes: bigint('reserved_bytes', { mode: 'number' }).notNull().default(0),
  },
  (t) => [check('storage_usage_nonnegative', sql`${t.usedBytes} >= 0 AND ${t.reservedBytes} >= 0`)],
);
