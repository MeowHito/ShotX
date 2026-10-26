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
import { authPool, billingMode, subscriptionStatus, userRole } from './enums';

/**
 * Everyone who signs in: photographers, viewers (role `user`) and admins.
 *
 * Identity is the pair (auth_pool, auth_subject) (ADR 0002, renamed from cognito_pool/cognito_sub
 * by migration 0005 for ADR 0008): a subject is only unique within its pool, and the API resolves
 * the pool from the token it verified, never from the request. Cognito subjects are raw; subjects
 * of ShotX-issued tokens carry their provider as a prefix (`line:`, `google:`, `local:`,
 * `admin:`; see @shotx/shared account/auth-subject). The CHECK ties `admin` to the admins pool
 * both ways, so a users-pool identity can never be an admin and an admins-pool identity is always
 * one.
 *
 * `users_id_auth_pool_unique` lets auth_sessions and admin_credentials reference (id, auth_pool),
 * so a session's pool is always its user's and only admins-pool users get admin credentials.
 * Password sign-in finds admins by email: `users_admin_email_unique` keeps it unique (ignoring
 * ASCII case) among ShotX admins (`admin:` subjects).
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    /** Optional: LINE only shares an email after LINE approves the email permission. */
    email: text('email'),
    name: text('name'),
    role: userRole('role').notNull().default('user'),
    authPool: authPool('auth_pool').notNull(),
    authSubject: text('auth_subject').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('users_auth_identity_unique').on(t.authPool, t.authSubject),
    unique('users_id_auth_pool_unique').on(t.id, t.authPool),
    uniqueIndex('users_admin_email_unique')
      .on(sql`lower(${t.email} COLLATE "C")`)
      .where(sql`${t.authPool} = 'admins' AND ${t.authSubject} LIKE 'admin:%'`),
    check('users_admin_iff_admins_pool', sql`(${t.role} = 'admin') = (${t.authPool} = 'admins')`),
    check('users_auth_subject_not_empty', sql`length(${t.authSubject}) > 0`),
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
 * expired and purged rows stay as history. A `new` checkout reuses the latest row unless it is
 * purged (then it inserts a new one). The lifecycle rules are in @shotx/shared billing/subscription.
 *
 * Migration 0004 (billing):
 * - `period_start`: start of the current paid period (trial: onboarding time);
 * - `pending_plan_id` / `pending_plan_effective_at`: a scheduled downgrade, set together;
 * - auto-renew: `billing = 'auto_renew'` exactly when `payment_method_ref` (the gateway's id of
 *   the saved card, never card data), `payment_method_gateway` and `auto_renew_months` (1 or 12)
 *   are set. Cancelling auto-renew clears them and sets `cancel_at_period_end`;
 * - `updated_at`: set by every change (the api and worker write it; no trigger).
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
    periodStart: timestamptz('period_start').notNull().defaultNow(),
    periodEnd: timestamptz('period_end').notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    autoRenewMonths: integer('auto_renew_months'),
    paymentMethodGateway: text('payment_method_gateway'),
    paymentMethodRef: text('payment_method_ref'),
    pendingPlanId: uuid('pending_plan_id').references(() => plans.id),
    pendingPlanEffectiveAt: timestamptz('pending_plan_effective_at'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscriptions_one_live_per_photographer')
      .on(t.photographerId)
      .where(sql`${t.status} IN ('trial', 'active', 'grace')`),
    index('subscriptions_photographer_idx').on(t.photographerId),
    index('subscriptions_status_period_end_idx').on(t.status, t.periodEnd),
    // The daily job's pending downgrades.
    index('subscriptions_pending_plan_idx')
      .on(t.pendingPlanEffectiveAt)
      .where(sql`${t.pendingPlanId} IS NOT NULL`),
    check('subscriptions_period_order', sql`${t.periodStart} <= ${t.periodEnd}`),
    check(
      'subscriptions_auto_renew_has_method',
      sql`(${t.billing} = 'auto_renew') = (${t.paymentMethodRef} IS NOT NULL) AND (${t.paymentMethodRef} IS NULL) = (${t.paymentMethodGateway} IS NULL) AND (${t.billing} = 'auto_renew') = (${t.autoRenewMonths} IS NOT NULL)`,
    ),
    check(
      'subscriptions_auto_renew_months_valid',
      sql`${t.autoRenewMonths} IS NULL OR ${t.autoRenewMonths} IN (1, 12)`,
    ),
    check(
      'subscriptions_pending_plan_complete',
      sql`(${t.pendingPlanId} IS NULL) = (${t.pendingPlanEffectiveAt} IS NULL)`,
    ),
    check(
      'subscriptions_payment_method_ref_valid',
      sql`${t.paymentMethodRef} IS NULL OR length(${t.paymentMethodRef}) BETWEEN 1 AND 255`,
    ),
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
