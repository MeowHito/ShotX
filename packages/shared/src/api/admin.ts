import { z } from 'zod';
import {
  accountEmailSchema,
  accountNameSchema,
  newPasswordSchema,
} from '../account/password-accounts';
import { satangSchema } from '../billing/money';
import { ADMIN_LIST_PAGE_SIZE_LIMIT } from '../config/admin-console';
import { CURSOR_MAX_LENGTH, decodeOpaqueCursor, encodeOpaqueCursor } from '../cursor-codec';
import { ACCOUNT_ROLES, ACCOUNT_STATUSES, type AdminAuditAction } from '../domain';
import { byteCountSchema, idSchema, isoDateTimeSchema } from './common';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from './share-page';

// Admin app routes (ADR 0010): user management and the optional cash-payment ledger. Every route
// is RouteAuth `admin` (an admins-pool token with `pwd` + `otp`), and every mutation writes
// audit_log (ADMIN_AUDIT_ACTIONS) in its transaction. Only these routes create `admin` or
// `photographer` accounts; nothing lets anyone raise their own role.

// `limit` defaults to ADMIN_LIST_PAGE_SIZE (config/admin-console).
const cursorParam = z.string().min(1).max(CURSOR_MAX_LENGTH).optional();
const limitParam = z.coerce.number().int().min(1).max(ADMIN_LIST_PAGE_SIZE_LIMIT).optional();

// --- Users ----------------------------------------------------------------------------------------

/**
 * One account as the admin users page shows it. Accounts are `users` rows with role `admin` or
 * `photographer` (viewers are never listed); that includes photographers from before ADR 0010
 * (LINE/Google, `passwordAccount: false`).
 */
export const adminUserSchema = z.object({
  id: idSchema,
  /** Always set for password accounts; may be null for older LINE photographers. */
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: z.enum(ACCOUNT_ROLES),
  status: z.enum(ACCOUNT_STATUSES),
  /**
   * True for email + password accounts (`admin:` and `password:` subjects). Only these can have
   * their password reset (else CONFLICT).
   */
  passwordAccount: z.boolean(),
  /** The password is temporary: the next sign-in must change it. False without a password. */
  mustChangePassword: z.boolean(),
  /**
   * Admins only: true when `admin_credentials.totp_confirmed_at` is set, false while the admin has
   * no confirmed TOTP (a UI-created admin who hasn't finished the first sign-in, or a CLI
   * enrolment not yet confirmed); null for photographers. The admin UI flags `false` as "pending
   * enrolment": until then the creating admin, who knows the temporary password, could be the
   * first to sign in (ADR 0010 limitation), so a long-pending admin should be reset or disabled.
   * With ADMIN_MFA_MODE=off (ADR 0011) it is reported the same way but means nothing for sign-in;
   * the admin UI then hides the "pending enrolment" flag (GET /auth/providers `adminMfaMode`).
   */
  totpEnrolled: z.boolean().nullable(),
  /** Set while sign-in is locked after repeated failures (cleared by a password reset). */
  lockedUntil: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  /** The admin who created it (null: operator CLI, or before ADR 0010). */
  createdById: idSchema.nullable(),
  disabledAt: isoDateTimeSchema.nullable(),
  /** `users.last_sign_in_at`: the last successful sign-in (null: never). */
  lastSignInAt: isoDateTimeSchema.nullable(),
  /**
   * `storage_usage.used_bytes` (originals, trash included; reservations excluded). Photographers
   * only (0 when they have no row yet); null for admins.
   */
  usedBytes: byteCountSchema.nullable(),
  /**
   * Photos the photographer has uploaded: their image files (`image/*`) that finished uploading
   * (`processing` or `ready`) and are not in the trash. Videos are not counted. Photographers
   * only; null for admins.
   */
  photoCount: z.number().int().nonnegative().nullable(),
});
export type AdminUser = z.output<typeof adminUserSchema>;

/**
 * GET /admin/users. Newest first: ORDER BY created_at DESC, id DESC (CLI-created admins have
 * random v4 ids, so id alone is not creation order). `q` matches email or name containing it,
 * ignoring ASCII case (`lower(x COLLATE "C") LIKE` with `%` and `_` escaped). Filters combine
 * with AND. A cursor is only valid with the same filters; a malformed one is VALIDATION_FAILED.
 */
export const listAdminUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(254).optional(),
  role: z.enum(ACCOUNT_ROLES).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  cursor: cursorParam,
  limit: limitParam,
});
export type ListAdminUsersQuery = z.input<typeof listAdminUsersQuerySchema>;

/**
 * Cursor of GET /admin/users (opaque to clients): the last item's `created_at::text` (full
 * microsecond precision; a JavaScript Date would truncate it) and id.
 */
export const adminUserCursorSchema = z.object({
  v: z.literal(1),
  createdAt: z.string().min(1).max(64),
  id: idSchema,
});
export type AdminUserCursor = z.output<typeof adminUserCursorSchema>;

export function encodeAdminUserCursor(cursor: AdminUserCursor): string {
  return encodeOpaqueCursor(adminUserCursorSchema, cursor);
}

/** The cursor, or null when `text` is not one. Never throws. */
export function decodeAdminUserCursor(text: string): AdminUserCursor | null {
  return decodeOpaqueCursor(adminUserCursorSchema, text);
}

export const listAdminUsersResponseSchema = z.object({
  items: z.array(adminUserSchema),
  nextCursor: z.string().nullable(),
});
export type ListAdminUsersResponse = z.output<typeof listAdminUsersResponseSchema>;

/**
 * POST /admin/users: create an account (201, the new item).
 * - `admin`: admins pool, subject adminAccountSubject(id), admin_credentials with the argon2id
 *   hash, `must_change_password = true` and no TOTP secret (enrolled at first sign-in with
 *   ADMIN_MFA_MODE=totp; with `off`, the default since ADR 0011, never; ADMIN_SIGN_IN_STEPS).
 * - `photographer`: users pool, subject passwordAccountSubject(id), user_password_credentials
 *   (`must_change_password = true`) and a storage_usage row.
 * The password is temporary: TEMPORARY_PASSWORD_MIN_LENGTH code points, nothing else
 * (temporaryPasswordViolation, ADR 0015); the first sign-in replaces it under the pool's policy.
 * `created_by_id` is the acting admin. EMAIL_TAKEN when another password account (either pool)
 * has the email ignoring ASCII case; PASSWORD_TOO_WEAK (`too_short`) for a short password. The
 * password is never logged, audited or returned; the admin hands it over out of band.
 */
export const createAdminUserBodySchema = z.strictObject({
  email: accountEmailSchema,
  name: accountNameSchema,
  role: z.enum(ACCOUNT_ROLES),
  password: newPasswordSchema,
});
export type CreateAdminUserBody = z.input<typeof createAdminUserBodySchema>;

/**
 * PATCH /admin/users/:id: rename and/or disable/enable (at least one field). Role never changes.
 * - `status: 'disabled'`: sets `disabled_at`, revokes every auth_sessions family of the account,
 *   and (photographers) takes their shares offline (SHARE_EXPIRED `unavailable`). Idempotent
 *   (already disabled: no-op, no audit row).
 *   - Own account: always CANNOT_MODIFY_SELF (checked first), so an admin can never lock
 *     themself out, even when other admins exist.
 *   - LAST_ADMIN: disabling another admin who is the last *other* active admin, i.e. no active
 *     admin would remain. Since the caller is an active admin, this only happens in a race (e.g.
 *     two admins disabling each other at once, or the caller being disabled meanwhile); the api
 *     checks the count inside the transaction, locking the active admin rows (FOR UPDATE).
 * - `status: 'active'`: clears `disabled_at`. Sessions are not restored.
 * Viewers (role `user`) are NOT_FOUND here.
 */
export const updateAdminUserBodySchema = z
  .strictObject({
    name: accountNameSchema.optional(),
    status: z.enum(ACCOUNT_STATUSES).optional(),
  })
  .refine((b) => b.name !== undefined || b.status !== undefined, {
    error: 'name or status is required',
  });
export type UpdateAdminUserBody = z.input<typeof updateAdminUserBodySchema>;

/**
 * POST /admin/users/:id/reset-password: a new temporary password (200, the item). Sets
 * `must_change_password = true`, clears `failed_attempts` and `locked_until`, revokes every
 * session of the account. An admin's TOTP is kept (they change the password, then enter their
 * code). Own account: CANNOT_MODIFY_SELF; not a password account: CONFLICT; shorter than
 * TEMPORARY_PASSWORD_MIN_LENGTH: PASSWORD_TOO_WEAK.
 */
export const resetAdminUserPasswordBodySchema = z.strictObject({ password: newPasswordSchema });
export type ResetAdminUserPasswordBody = z.input<typeof resetAdminUserPasswordBodySchema>;

// --- System overview (ADR 0016) --------------------------------------------------------------

const bytes = z.number().int().nonnegative();

/**
 * GET /admin/system: the overview tab. Every part is measured on the server; a part that can't
 * be measured is null (never a guess).
 * - `storage`: what the database records: originals of all photographers (storage_usage, trash
 *   included, as quota counts them), their uploaded photos and videos, and the database's size.
 * - `bucket`: the media bucket (Cloudflare R2) counted by listing it, originals and every
 *   derivative included, by top-level prefix; reused for ADMIN_STORAGE_SCAN_TTL_SECONDS
 *   (`measuredAt`). Null when listing isn't allowed or failed. R2 has no capacity limit.
 * - `server`: the VPS the api runs on, read from the kernel (/proc, statfs): CPU use over a short
 *   sample, load averages, memory, the disk at ADMIN_SYSTEM_DISK_PATH, uptime, and the hottest
 *   thermal sensor in °C (null on a virtual machine without sensors).
 */
export const adminSystemResponseSchema = z.object({
  generatedAt: isoDateTimeSchema,
  storage: z.object({
    originalsBytes: bytes,
    photoCount: z.number().int().nonnegative(),
    videoCount: z.number().int().nonnegative(),
    photographerCount: z.number().int().nonnegative(),
    databaseBytes: bytes.nullable(),
  }),
  bucket: z
    .object({
      name: z.string(),
      objectCount: z.number().int().nonnegative(),
      totalBytes: bytes,
      prefixes: z.array(
        z.object({ prefix: z.string(), objectCount: z.number().int().nonnegative(), bytes }),
      ),
      measuredAt: isoDateTimeSchema,
    })
    .nullable(),
  server: z.object({
    hostname: z.string(),
    cpuCount: z.number().int().positive(),
    /** Busy share of all CPUs over the sample, 0–100. */
    cpuPercent: z.number().min(0).max(100).nullable(),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
    memory: z.object({ totalBytes: bytes, usedBytes: bytes }),
    disk: z.object({ path: z.string(), totalBytes: bytes, usedBytes: bytes }).nullable(),
    uptimeSeconds: z.number().nonnegative(),
    temperatureC: z.number().nullable(),
  }),
});
export type AdminSystemResponse = z.output<typeof adminSystemResponseSchema>;

// --- Act as a photographer (ADR 0018) ------------------------------------------------------

/**
 * POST /admin/users/:id/act-as: a one-time link that opens the photographer's studio as them, for
 * ADMIN_ACT_AS_SESSION_SECONDS. Open it in a new tab; it works once, within
 * ADMIN_ACT_AS_CODE_SECONDS (`expiresAt`). Photographers only, active accounts only (else
 * CONFLICT); audited (`admin.user.act_as`), and so is every change made in that session.
 */
export const actAsResponseSchema = z.object({ url: z.url(), expiresAt: isoDateTimeSchema });
export type ActAsResponse = z.output<typeof actAsResponseSchema>;

// --- Audit metas (ADR 0010) -------------------------------------------------------------------

/**
 * `audit_log.meta` of each ADMIN_AUDIT_ACTIONS action, as the api writes it and the audit-log
 * viewer reads it. Never a password, hash or TOTP secret.
 */
export const ADMIN_AUDIT_META_SCHEMAS = {
  'admin.user.created': z.object({ role: z.enum(ACCOUNT_ROLES), email: z.string() }),
  'admin.user.updated': z
    .object({
      changed: z.array(z.enum(['name', 'status'])).min(1),
      oldName: z.string().nullable().optional(),
      newName: z.string().nullable().optional(),
    })
    .refine(
      (m) => !m.changed.includes('name') || (m.oldName !== undefined && m.newName !== undefined),
      {
        error: 'oldName and newName are required when name changed',
      },
    ),
  'admin.user.disabled': z.object({ revokedSessions: z.number().int().nonnegative() }),
  'admin.user.enabled': z.object({}),
  'admin.user.password_reset': z.object({}),
  'admin.cash_payment.created': z.object({
    photographerId: idSchema,
    amountSatang: z.number().int().positive().max(2_147_483_647),
    paidAt: isoDateTimeSchema,
  }),
  'admin.user.act_as': z.object({ expiresAt: isoDateTimeSchema }),
  'admin.act_as.request': z.object({
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    /** The route's path pattern (e.g. `/drive/files/:id`), never ids from the body. */
    route: z.string(),
    sessionId: idSchema,
  }),
} as const satisfies Record<AdminAuditAction, z.ZodType>;

export type AdminAuditMeta<A extends AdminAuditAction> = z.output<
  (typeof ADMIN_AUDIT_META_SCHEMAS)[A]
>;

// --- Cash payments (optional ledger) --------------------------------------------------------------

/** Longest `cash_payments.note`. */
export const CASH_PAYMENT_NOTE_MAX_LENGTH = 500;

/**
 * Largest single cash payment: the `integer` column's maximum (2^31 - 1 satang, about 21.47
 * million THB).
 */
export const CASH_PAYMENT_MAX_SATANG = 2_147_483_647;

/**
 * How far after the recording time `paid_at` may be: 1 day, the same as the DB CHECK
 * `cash_payments_paid_at_not_future` (`paid_at <= created_at + interval '1 day'`). A later
 * `paidAt` is VALIDATION_FAILED.
 */
export const CASH_PAYMENT_PAID_AT_MAX_AHEAD_SECONDS = 86_400;

/** One recorded cash payment. Money is integer satang (VAT is not split: bookkeeping only). */
export const cashPaymentSchema = z.object({
  id: idSchema,
  photographerId: idSchema,
  amountSatang: satangSchema.positive().max(CASH_PAYMENT_MAX_SATANG),
  paidAt: isoDateTimeSchema,
  note: z.string().nullable(),
  recordedById: idSchema,
  createdAt: isoDateTimeSchema,
});
export type AdminCashPayment = z.output<typeof cashPaymentSchema>;

/**
 * GET /admin/cash-payments, optionally of one photographer. ORDER BY paid_at DESC, id DESC
 * (cash_payments_photographer_paid_idx / cash_payments_paid_idx).
 */
export const listCashPaymentsQuerySchema = z.object({
  photographerId: idSchema.optional(),
  cursor: cursorParam,
  limit: limitParam,
});
export type ListCashPaymentsQuery = z.input<typeof listCashPaymentsQuerySchema>;

/** Cursor of GET /admin/cash-payments: the last item's `paid_at::text` and id. */
export const cashPaymentCursorSchema = z.object({
  v: z.literal(1),
  paidAt: z.string().min(1).max(64),
  id: idSchema,
});
export type CashPaymentCursor = z.output<typeof cashPaymentCursorSchema>;

export function encodeCashPaymentCursor(cursor: CashPaymentCursor): string {
  return encodeOpaqueCursor(cashPaymentCursorSchema, cursor);
}

/** The cursor, or null when `text` is not one. Never throws. */
export function decodeCashPaymentCursor(text: string): CashPaymentCursor | null {
  return decodeOpaqueCursor(cashPaymentCursorSchema, text);
}

export const listCashPaymentsResponseSchema = z.object({
  items: z.array(cashPaymentSchema),
  nextCursor: z.string().nullable(),
});
export type ListCashPaymentsResponse = z.output<typeof listCashPaymentsResponseSchema>;

/** `Idempotency-Key` is required (VALIDATION_FAILED at `headers.idempotency-key` without it). */
export const createCashPaymentHeadersSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema,
});

/**
 * POST /admin/cash-payments (201, the row): record a cash payment against a photographer (any
 * status; recording one doesn't enable the account). Inserted with its audit_log row in one
 * transaction. Idempotent per recording admin and Idempotency-Key: the same key with the same
 * request (`request_sha256` of photographerId, amountSatang, paidAt, note) returns the first
 * row; with a different request IDEMPOTENCY_KEY_REUSED. Not a photographer: NOT_FOUND. `paidAt`
 * more than a day in the future: VALIDATION_FAILED (cash_payments_paid_at_not_future).
 */
export const createCashPaymentBodySchema = z.strictObject({
  photographerId: idSchema,
  amountSatang: z.number().int().positive().max(CASH_PAYMENT_MAX_SATANG),
  paidAt: isoDateTimeSchema,
  /** Trimmed; empty becomes absent. */
  note: z
    .string()
    .trim()
    .max(CASH_PAYMENT_NOTE_MAX_LENGTH)
    .transform((n) => (n === '' ? undefined : n))
    .optional(),
});
export type CreateCashPaymentBody = z.input<typeof createCashPaymentBodySchema>;
