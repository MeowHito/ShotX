import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import { authPool, packageKind, packageOrderStatus } from './enums';

// Time-boxed packages, self sign-up and online payment (ADR 0026, migration 0016). Separate from
// the switched-off subscription billing (`plans`, `subscriptions`, `payments`), which is untouched.
// Money is integer satang; package prices are VAT-exclusive (vatOnTop / packageTotal in
// @shotx/shared). The pure rules (applyPackage, packageExpired, photosRemaining,
// packageUploadsBlockedBy) are in @shotx/shared billing/packages.

/**
 * What can be bought (or, for `free`, signed up for). Seeded by migration 0016 with free, d3, d7,
 * d15 and d30 (`INSERT ... ON CONFLICT (code) DO NOTHING`); prices and limits are edited in the
 * DB, never in code. `free` must cost nothing (`packages_free_costs_nothing`).
 *
 * ADR 0032 (migration 0022): `kind` (PACKAGE_KINDS). A `plan` has days and photos; a `days`
 * add-on has `photo_limit` 0 and a `photos` add-on `days` 0 (`packages_kind_terms`). Migration
 * 0022 seeds day1, day3, day7, photo1000, photo3000 and photo5000.
 */
export const packages = pgTable(
  'packages',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: packageKind('kind').notNull().default('plan'),
    days: integer('days').notNull(),
    photoLimit: integer('photo_limit').notNull(),
    /** VAT-exclusive price in satang. */
    priceSatang: integer('price_satang').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Card order on the home page, ascending. */
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    unique('packages_code_unique').on(t.code),
    check('packages_code_format', sql`${t.code} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check('packages_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check(
      'packages_kind_terms',
      sql`(${t.kind} = 'plan' AND ${t.days} > 0 AND ${t.photoLimit} > 0) OR (${t.kind} = 'days' AND ${t.days} > 0 AND ${t.photoLimit} = 0) OR (${t.kind} = 'photos' AND ${t.days} = 0 AND ${t.photoLimit} > 0)`,
    ),
    check('packages_price_nonnegative', sql`${t.priceSatang} >= 0`),
    check('packages_free_costs_nothing', sql`${t.code} <> 'free' OR ${t.priceSatang} = 0`),
    check('packages_free_is_plan', sql`${t.code} <> 'free' OR ${t.kind} = 'plan'`),
  ],
);

/**
 * The photographer's package: one row per account, written only by applyPackage's values in a
 * transaction that locked it (`FOR UPDATE`). No row = unlimited (every admin-created account).
 *
 * - (photographer_id, photographer_pool) references users (id, auth_pool) with the pool fixed to
 *   `users`, so an admin can never have a package (as in cash_payments).
 * - `package_id`: the package applied last.
 * - `photo_limit` / `photos_used`: POST /uploads/init increments `photos_used` with a guarded
 *   UPDATE (`photos_used + n <= photo_limit`, else PHOTO_LIMIT_REACHED) in the file row's
 *   transaction; an abort (DELETE /uploads/:id) gives it back. Deliberately no
 *   `photos_used <= photo_limit` CHECK: the guard is the UPDATE.
 * - `updated_at`: set by every change (the api writes it; no trigger).
 */
export const photographerPackages = pgTable(
  'photographer_packages',
  {
    photographerId: uuid('photographer_id').primaryKey(),
    photographerPool: authPool('photographer_pool').notNull().default('users'),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id),
    startsAt: timestamptz('starts_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    photoLimit: integer('photo_limit').notNull(),
    photosUsed: integer('photos_used').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'photographer_packages_photographer_fk',
      columns: [t.photographerId, t.photographerPool],
      foreignColumns: [users.id, users.authPool],
    }),
    // The admin users list and later expiry jobs.
    index('photographer_packages_expires_idx').on(t.expiresAt),
    check('photographer_packages_photographer_pool', sql`${t.photographerPool} = 'users'`),
    check('photographer_packages_period_order', sql`${t.startsAt} < ${t.expiresAt}`),
    check('photographer_packages_photo_limit_positive', sql`${t.photoLimit} > 0`),
    check('photographer_packages_photos_used_nonnegative', sql`${t.photosUsed} >= 0`),
  ],
);

/**
 * Coupons (ADR 0030, migration 0020): an admin-made code worth `percent_off` (1-100) off a
 * package's VAT-exclusive price, for at most `max_redemptions` orders. Never deleted (orders keep
 * their coupon); `is_active` switches one off. Uses are counted from package_orders (paid, plus
 * pending or failed ones younger than PACKAGE_COUPON_HOLD_SECONDS) with this row locked, so no
 * counter can drift.
 *
 * - `code`: stored upper-case (COUPON_CODE_PATTERN); typed codes are upper-cased first.
 * - (created_by_id, created_by_pool) references users (id, auth_pool) with the pool fixed to
 *   `admins` (as expenses).
 */
export const packageCoupons = pgTable(
  'package_coupons',
  {
    id: id(),
    code: text('code').notNull(),
    percentOff: integer('percent_off').notNull(),
    maxRedemptions: integer('max_redemptions').notNull(),
    expiresAt: timestamptz('expires_at'),
    isActive: boolean('is_active').notNull().default(true),
    note: text('note'),
    createdById: uuid('created_by_id').notNull(),
    createdByPool: authPool('created_by_pool').notNull().default('admins'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('package_coupons_code_unique').on(t.code),
    foreignKey({
      name: 'package_coupons_created_by_admin_fk',
      columns: [t.createdById, t.createdByPool],
      foreignColumns: [users.id, users.authPool],
    }),
    check('package_coupons_code_format', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'`),
    check('package_coupons_percent_off_range', sql`${t.percentOff} BETWEEN 1 AND 100`),
    check('package_coupons_max_redemptions_positive', sql`${t.maxRedemptions} > 0`),
    check('package_coupons_created_by_pool', sql`${t.createdByPool} = 'admins'`),
    check(
      'package_coupons_note_length',
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 200`,
    ),
  ],
);

const gatewayFormat = (column: unknown) => sql`${column} ~ '^[a-z0-9_]{1,32}$'`;

/**
 * Paid package orders (POST /package-orders) and the idempotency store of that route.
 *
 * - `photographer_id`: the signed-in buyer's account at creation, else set when the paid callback
 *   resolves (an existing photographer with the email, or a new account; `account_created`).
 * - `email` (as typed, trimmed; looked up by `lower(email COLLATE "C")`, the normalizeAccountEmail
 *   key) and `name`: the buyer's, for the account and receipts (personal data).
 * - Amounts: packageTotal at creation; `vat_rate_basis_points` is the rate used.
 * - `gateway` (PACKAGE_PAYMENT_GATEWAYS) and `gateway_ref` (the gateway's id; null until the
 *   gateway gives one): UNIQUE (gateway, gateway_ref) finds the order of a callback.
 * - `access_token_hash`: lowercase hex SHA-256 of the 43-character base64url access token (256
 *   bits, so a fast hash is enough, as `auth_sessions.refresh_token_hash`). Compared in constant
 *   time with the X-Order-Token header. A replay of the same request replaces it (only the hash is
 *   stored, so the replay answers a new token).
 * - `idempotency_key` UNIQUE (the Idempotency-Key header, global: anonymous buyers have no account
 *   to scope it to) with `request_sha256` (hex SHA-256 of the canonical request: package code,
 *   email, name, photographer id) to tell a replay from a reused key (IDEMPOTENCY_KEY_REUSED);
 *   `redirect_url` lets a replay answer the same checkout page.
 * - `paid` means applied: `paid_at`, `applied_at` and `photographer_id` are set exactly then, in
 *   the callback's transaction.
 */
export const packageOrders = pgTable(
  'package_orders',
  {
    id: id(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id),
    photographerId: uuid('photographer_id').references(() => users.id),
    email: text('email').notNull(),
    name: text('name'),
    priceSatang: integer('price_satang').notNull(),
    vatSatang: integer('vat_satang').notNull(),
    totalSatang: integer('total_satang').notNull(),
    vatRateBasisPoints: integer('vat_rate_basis_points').notNull(),
    gateway: text('gateway').notNull(),
    gatewayRef: text('gateway_ref'),
    redirectUrl: text('redirect_url'),
    /**
     * Migration 0019 (ADR 0029): the gateway's ids of each payment attempt (mPAY `order_id`,
     * newest first, at most PACKAGE_ORDER_MAX_ATTEMPTS), asked by GET /package-orders/:id.
     */
    gatewayAttempts: text('gateway_attempts')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * Migration 0020 (ADR 0030): the order's coupon, its code as typed (upper-case) and what it took
     * off the VAT-exclusive price; `price_satang` is the price after it (discountedPackageTotal).
     */
    couponId: uuid('coupon_id').references(() => packageCoupons.id),
    couponCode: text('coupon_code'),
    discountSatang: integer('discount_satang').notNull().default(0),
    status: packageOrderStatus('status').notNull().default('pending'),
    accessTokenHash: text('access_token_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestSha256: text('request_sha256').notNull(),
    /** True when the paid callback created the buyer's account. */
    accountCreated: boolean('account_created').notNull().default(false),
    paidAt: timestamptz('paid_at'),
    appliedAt: timestamptz('applied_at'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('package_orders_gateway_ref_unique').on(t.gateway, t.gatewayRef),
    unique('package_orders_idempotency_key_unique').on(t.idempotencyKey),
    index('package_orders_photographer_created_idx').on(
      t.photographerId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('package_orders_email_idx').on(sql`lower(${t.email} COLLATE "C")`, t.createdAt.desc()),
    index('package_orders_pending_created_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // Migration 0017 (ADR 0027): finance income by `paid_at`.
    index('package_orders_paid_idx')
      .on(t.paidAt)
      .where(sql`${t.status} = 'paid'`),
    // ADR 0030: the uses of a coupon (paid and recent pending orders).
    index('package_orders_coupon_idx')
      .on(t.couponId, t.createdAt)
      .where(sql`${t.couponId} IS NOT NULL`),
    check(
      'package_orders_coupon_consistent',
      sql`(${t.couponId} IS NULL) = (${t.couponCode} IS NULL) AND (${t.couponId} IS NOT NULL OR ${t.discountSatang} = 0)`,
    ),
    check('package_orders_discount_nonnegative', sql`${t.discountSatang} >= 0`),
    check(
      'package_orders_amounts_valid',
      sql`${t.priceSatang} >= 0 AND ${t.vatSatang} >= 0 AND ${t.totalSatang} >= 0`,
    ),
    check(
      'package_orders_total_is_price_plus_vat',
      sql`${t.totalSatang} = ${t.priceSatang} + ${t.vatSatang}`,
    ),
    check('package_orders_vat_rate_valid', sql`${t.vatRateBasisPoints} BETWEEN 0 AND 10000`),
    check('package_orders_gateway_format', gatewayFormat(t.gateway)),
    check(
      'package_orders_gateway_ref_valid',
      sql`${t.gatewayRef} IS NULL OR char_length(${t.gatewayRef}) BETWEEN 1 AND 255`,
    ),
    check(
      'package_orders_email_valid',
      sql`char_length(${t.email}) BETWEEN 3 AND 254 AND position('@' in ${t.email}) > 1`,
    ),
    check(
      'package_orders_name_length',
      sql`${t.name} IS NULL OR char_length(${t.name}) BETWEEN 1 AND 200`,
    ),
    check('package_orders_access_token_hash_hex', sql`${t.accessTokenHash} ~ '^[0-9a-f]{64}$'`),
    check('package_orders_idempotency_key_format', sql`${t.idempotencyKey} ~ '^[!-~]{1,255}$'`),
    check('package_orders_request_sha256_hex', sql`${t.requestSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'package_orders_paid_iff_applied',
      sql`(${t.status} = 'paid') = (${t.paidAt} IS NOT NULL) AND (${t.status} = 'paid') = (${t.appliedAt} IS NOT NULL)`,
    ),
    check(
      'package_orders_applied_has_photographer',
      sql`${t.appliedAt} IS NULL OR ${t.photographerId} IS NOT NULL`,
    ),
    check(
      'package_orders_account_created_when_paid',
      sql`NOT ${t.accountCreated} OR ${t.status} = 'paid'`,
    ),
  ],
);
