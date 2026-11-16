import { z } from 'zod';
import { BANGKOK_UTC_OFFSET_MS, MS_PER_BILLING_DAY } from '../billing/period';
import { ADMIN_LIST_PAGE_SIZE_LIMIT } from '../config/admin-console';
import { CURSOR_MAX_LENGTH, decodeOpaqueCursor, encodeOpaqueCursor } from '../cursor-codec';
import { EXPENSE_CATEGORIES, PACKAGE_ORDER_STATUSES, type FinanceAuditAction } from '../domain';
import { byteCountSchema, idSchema, isoDateTimeSchema } from './common';
import { packageCodeSchema } from './packages';
import { bangkokDateSchema } from './shares';

// Admin finance and the audit log viewer (ADR 0027). Every route is RouteAuth `admin` (ADMIN_ROUTES
// in api/routes). Money is integer satang everywhere; days are Asia/Bangkok calendar days
// (`YYYY-MM-DD`, bangkokDateSchema) and ranges include both ends. Lists are cursor-paginated like
// the other admin lists (`limit` defaults to ADMIN_LIST_PAGE_SIZE; a malformed cursor, or one
// used with other filters, is VALIDATION_FAILED).

const cursorParam = z.string().min(1).max(CURSOR_MAX_LENGTH).optional();
const limitParam = z.coerce.number().int().min(1).max(ADMIN_LIST_PAGE_SIZE_LIMIT).optional();

/** A sum of satang (may exceed a single amount's limit, never 2^53). */
export const satangTotalSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A signed amount of satang (profit; negative is a loss). */
export const signedSatangSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

const count = z.number().int().nonnegative();

// --- Bangkok day ranges (pure helpers) -----------------------------------------------------------

/** Whole days from `from` to `to` (Bangkok dates `YYYY-MM-DD`); negative when `to` is earlier. */
export function bangkokDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `date` (a Bangkok date) plus whole days, as a Bangkok date. */
export function addBangkokDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer, got ${days}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The instants an inclusive range of Bangkok days covers: `start` is `from` 00:00 (+07:00) and
 * `end` (exclusive) is the day after `to` at 00:00 (+07:00). Query `created_at >= start AND
 * created_at < end`.
 */
export function bangkokRangeInstants(from: string, to: string): { start: Date; end: Date } {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) - BANGKOK_UTC_OFFSET_MS;
  return { start: new Date(day(from)), end: new Date(day(to) + MS_PER_BILLING_DAY) };
}

const fromNotAfterTo = (q: { from?: string | undefined; to?: string | undefined }) =>
  q.from === undefined || q.to === undefined || q.from <= q.to;

// --- GET /admin/audit-log (§1) --------------------------------------------------------------------

/**
 * The `action` filter: an exact action (`admin.user.created`), or a prefix ending in `.`
 * (`package.`, `auth.photographer.`) that matches every action starting with it
 * (isAuditActionPrefix). The api matches a prefix with `LIKE` and `_` / `%` escaped (`_` occurs
 * in actions), so it uses `audit_log_action_idx` (text_pattern_ops).
 */
export const auditActionFilterSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.?$/, {
    error: 'must be an audit action or a prefix ending in "."',
  });

/** Most values one `action` filter of GET /admin/audit-log may hold. */
export const AUDIT_ACTION_FILTER_MAX_VALUES = 10;

/**
 * The `action` query parameter of GET /admin/audit-log: one or more auditActionFilterSchema
 * values, matched with OR. Send them comma-separated (`action=package.,account.self_signup`), as
 * a repeated parameter (`action=package.&action=account.self_signup`), or both; each value is
 * trimmed, duplicates are dropped, and 1 to AUDIT_ACTION_FILTER_MAX_VALUES values are allowed (an
 * empty value, e.g. a trailing comma, is VALIDATION_FAILED). Parses to a string array.
 */
export const auditActionFilterListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((raw) => (Array.isArray(raw) ? raw : [raw]).flatMap((v) => v.split(',')))
  .transform((values) => values.map((v) => v.trim()))
  .pipe(z.array(auditActionFilterSchema).min(1).max(AUDIT_ACTION_FILTER_MAX_VALUES))
  .transform((values) => [...new Set(values)]);

/** True when an `action` filter is a prefix (ends in `.`), false for an exact action. */
export function isAuditActionPrefix(filter: string): boolean {
  return filter.endsWith('.');
}

/**
 * GET /admin/audit-log. Newest first: ORDER BY created_at DESC, id DESC (`audit_log_created_idx`;
 * with a filter `audit_log_action_idx`, `audit_log_actor_created_idx` or
 * `audit_log_target_id_idx`). Filters combine with AND:
 * - `action`: auditActionFilterListSchema (one or more exact actions or prefixes, OR-ed);
 * - `actorId`: rows of that actor (a user id);
 * - `targetId`: rows whose `target_id` is exactly this (a user, order, expense or cash payment
 *   id; target ids are text, so anything 1-255 characters);
 * - `from` / `to`: Bangkok days of `created_at`, both inclusive (bangkokRangeInstants); either may
 *   be absent (no bound). `from` after `to` is VALIDATION_FAILED.
 */
export const listAuditLogQuerySchema = z
  .object({
    action: auditActionFilterListSchema.optional(),
    actorId: idSchema.optional(),
    targetId: z.string().trim().min(1).max(255).optional(),
    from: bangkokDateSchema.optional(),
    to: bangkokDateSchema.optional(),
    cursor: cursorParam,
    limit: limitParam,
  })
  .refine(fromNotAfterTo, { error: 'from must not be after to', path: ['from'] });
export type ListAuditLogQuery = z.input<typeof listAuditLogQuerySchema>;

/** Cursor of GET /admin/audit-log: the last item's `created_at::text` and id. */
export const auditLogCursorSchema = z.object({
  v: z.literal(1),
  createdAt: z.string().min(1).max(64),
  id: idSchema,
});
export type AuditLogCursor = z.output<typeof auditLogCursorSchema>;

export function encodeAuditLogCursor(cursor: AuditLogCursor): string {
  return encodeOpaqueCursor(auditLogCursorSchema, cursor);
}

/** The cursor, or null when `text` is not one. Never throws. */
export function decodeAuditLogCursor(text: string): AuditLogCursor | null {
  return decodeOpaqueCursor(auditLogCursorSchema, text);
}

/**
 * One audit_log row. `action` is a plain string: rows may hold actions outside AUDIT_ACTIONS
 * (the viewer shows those raw). `actorEmail` is the actor's `users.email` (null for a null
 * actor, shown as "ระบบ", or an actor without an email). `targetEmail` is set when `target_type`
 * is `user` and that user has an email, else null. `meta` is returned as stored: by ADR 0010,
 * 0018, 0026 and 0027 it never holds secrets, tokens, passwords or selfies.
 */
export const auditLogEntrySchema = z.object({
  id: idSchema,
  createdAt: isoDateTimeSchema,
  action: z.string().min(1),
  actorId: idSchema.nullable(),
  actorEmail: z.string().nullable(),
  targetType: z.string(),
  targetId: z.string(),
  targetEmail: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
});
export type AuditLogEntry = z.output<typeof auditLogEntrySchema>;

export const listAuditLogResponseSchema = z.object({
  items: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ListAuditLogResponse = z.output<typeof listAuditLogResponseSchema>;

// --- Expenses (§2) --------------------------------------------------------------------------------

/** Longest `expenses.note` (the `expenses_note_length` CHECK). */
export const EXPENSE_NOTE_MAX_LENGTH = 500;

/** Largest single expense: the `integer` column's maximum (2^31 - 1 satang). */
export const EXPENSE_MAX_SATANG = 2_147_483_647;

/**
 * How many Bangkok days after the recording day `spentOn` may be: 1, the same as the DB CHECK
 * `expenses_spent_on_not_future`. A later `spentOn` is VALIDATION_FAILED (the api checks it
 * against today; the schema can't know the date).
 */
export const EXPENSE_SPENT_ON_MAX_AHEAD_DAYS = 1;

/** One live (not deleted) expense. */
export const expenseSchema = z.object({
  id: idSchema,
  spentOn: bangkokDateSchema,
  amountSatang: z.number().int().positive().max(EXPENSE_MAX_SATANG),
  category: z.enum(EXPENSE_CATEGORIES),
  note: z.string().nullable(),
  /** The admin who recorded it. */
  recordedById: idSchema,
  createdAt: isoDateTimeSchema,
});
export type AdminExpense = z.output<typeof expenseSchema>;

/**
 * GET /admin/expenses: live expenses (deleted ones are never listed), ORDER BY spent_on DESC,
 * id DESC (`expenses_spent_on_idx`). `from` / `to`: Bangkok days of `spent_on`, both inclusive;
 * either may be absent (no bound; with neither, the whole ledger). `from` after `to` is
 * VALIDATION_FAILED.
 */
export const listExpensesQuerySchema = z
  .object({
    from: bangkokDateSchema.optional(),
    to: bangkokDateSchema.optional(),
    cursor: cursorParam,
    limit: limitParam,
  })
  .refine(fromNotAfterTo, { error: 'from must not be after to', path: ['from'] });
export type ListExpensesQuery = z.input<typeof listExpensesQuerySchema>;

/** Cursor of GET /admin/expenses: the last item's `spent_on` and id. */
export const expenseCursorSchema = z.object({
  v: z.literal(1),
  spentOn: bangkokDateSchema,
  id: idSchema,
});
export type ExpenseCursor = z.output<typeof expenseCursorSchema>;

export function encodeExpenseCursor(cursor: ExpenseCursor): string {
  return encodeOpaqueCursor(expenseCursorSchema, cursor);
}

/** The cursor, or null when `text` is not one. Never throws. */
export function decodeExpenseCursor(text: string): ExpenseCursor | null {
  return decodeOpaqueCursor(expenseCursorSchema, text);
}

export const listExpensesResponseSchema = z.object({
  items: z.array(expenseSchema),
  nextCursor: z.string().nullable(),
});
export type ListExpensesResponse = z.output<typeof listExpensesResponseSchema>;

/**
 * POST /admin/expenses (201, the row): record an expense. Inserted with its
 * `finance.expense_created` audit_log row in one transaction; `recorded_by` is the acting admin.
 * `spentOn` more than EXPENSE_SPENT_ON_MAX_AHEAD_DAYS after today (Bangkok): VALIDATION_FAILED.
 * Not idempotent (no Idempotency-Key): a duplicate is visible in the ledger and can be deleted.
 */
export const createExpenseBodySchema = z.strictObject({
  spentOn: bangkokDateSchema,
  amountSatang: z.number().int().positive().max(EXPENSE_MAX_SATANG),
  category: z.enum(EXPENSE_CATEGORIES),
  /** Trimmed; empty becomes absent. */
  note: z
    .string()
    .trim()
    .max(EXPENSE_NOTE_MAX_LENGTH)
    .transform((n) => (n === '' ? undefined : n))
    .optional(),
});
export type CreateExpenseBody = z.input<typeof createExpenseBodySchema>;

// DELETE /admin/expenses/:id (204): soft delete (sets `deleted_at`) with its
// `finance.expense_deleted` audit_log row in one transaction. An unknown id is NOT_FOUND; an
// expense already deleted is a no-op (204, no audit row), like disabling a disabled account.

// --- Audit metas (ADR 0027) ------------------------------------------------------------------

const expenseAuditMeta = z.object({
  spentOn: bangkokDateSchema,
  amountSatang: z.number().int().positive().max(EXPENSE_MAX_SATANG),
  category: z.enum(EXPENSE_CATEGORIES),
});

/**
 * `audit_log.meta` of each FINANCE_AUDIT_ACTIONS action, as the api writes it and the audit-log
 * viewer reads it. The note is not copied (free text; the ledger row keeps it).
 */
export const FINANCE_AUDIT_META_SCHEMAS = {
  'finance.expense_created': expenseAuditMeta,
  'finance.expense_deleted': expenseAuditMeta,
} as const satisfies Record<FinanceAuditAction, z.ZodType>;

export type FinanceAuditMeta<A extends FinanceAuditAction> = z.output<
  (typeof FINANCE_AUDIT_META_SCHEMAS)[A]
>;

// --- GET /admin/finance (§3) ----------------------------------------------------------------------

/** `bucket` of GET /admin/finance: one series point per Bangkok day or per Bangkok month. */
export const FINANCE_BUCKETS = ['day', 'month'] as const;
export type FinanceBucket = (typeof FINANCE_BUCKETS)[number];

/** Days of the default range (the last 30 days up to today, Bangkok). */
export const FINANCE_DEFAULT_DAYS = 30;

/** Longest range in days with `bucket=day` (one point per day). */
export const FINANCE_MAX_DAYS_BY_DAY = 366;

/** Longest range in days with `bucket=month` (about ten years). */
export const FINANCE_MAX_DAYS_BY_MONTH = 3660;

/** How many customers `topCustomers` lists. */
export const FINANCE_TOP_CUSTOMERS = 10;

/**
 * GET /admin/finance. `from` / `to`: Bangkok days, both inclusive. Defaults (resolveFinanceRange):
 * `to` = today (Bangkok); `from` = `to` − (FINANCE_DEFAULT_DAYS − 1), so with neither the last 30
 * days including today; `bucket` = `day`. A range longer than FINANCE_MAX_DAYS_BY_DAY (`day`) or
 * FINANCE_MAX_DAYS_BY_MONTH (`month`) days, or `from` after `to`, is VALIDATION_FAILED (checked
 * here when both are given, else by resolveFinanceRange in the api).
 */
export const financeQuerySchema = z
  .object({
    from: bangkokDateSchema.optional(),
    to: bangkokDateSchema.optional(),
    bucket: z.enum(FINANCE_BUCKETS).optional(),
  })
  .refine(fromNotAfterTo, { error: 'from must not be after to', path: ['from'] })
  .refine(
    (q) =>
      q.from === undefined ||
      q.to === undefined ||
      bangkokDaysBetween(q.from, q.to) + 1 <= financeMaxDays(q.bucket ?? 'day'),
    { error: 'range is too long for this bucket', path: ['to'] },
  );
export type FinanceQuery = z.input<typeof financeQuerySchema>;

/** FINANCE_MAX_DAYS_BY_DAY or FINANCE_MAX_DAYS_BY_MONTH. */
export function financeMaxDays(bucket: FinanceBucket): number {
  return bucket === 'day' ? FINANCE_MAX_DAYS_BY_DAY : FINANCE_MAX_DAYS_BY_MONTH;
}

export interface FinanceRange {
  from: string;
  to: string;
  bucket: FinanceBucket;
}

/**
 * The range GET /admin/finance answers for a parsed query, with the defaults applied (see
 * financeQuerySchema), given today's Bangkok date (bangkokDate(now)). Null when the result is
 * invalid (`from` after `to`, e.g. only a future `from`, or too long): VALIDATION_FAILED. Pure.
 */
export function resolveFinanceRange(
  query: { from?: string | undefined; to?: string | undefined; bucket?: FinanceBucket | undefined },
  today: string,
): FinanceRange | null {
  const bucket = query.bucket ?? 'day';
  const to = query.to ?? today;
  const from = query.from ?? addBangkokDays(to, -(FINANCE_DEFAULT_DAYS - 1));
  const days = bangkokDaysBetween(from, to) + 1;
  if (days < 1 || days > financeMaxDays(bucket)) return null;
  return { from, to, bucket };
}

/**
 * The `bucket` keys of a range, oldest first: every day (`YYYY-MM-DD`) or every month touched
 * (`YYYY-MM`, partial months included). `series` has exactly these, zero-filled. Pure.
 */
export function financeBucketKeys(range: FinanceRange): string[] {
  const keys: string[] = [];
  if (range.bucket === 'day') {
    for (let d = range.from; d <= range.to; d = addBangkokDays(d, 1)) keys.push(d);
    return keys;
  }
  let [year, month] = range.from.split('-').map(Number) as [number, number];
  const last = range.to.slice(0, 7);
  for (;;) {
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    keys.push(key);
    if (key >= last) return keys;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/**
 * The range's totals. Income is by `paid_at` (Bangkok day), manual expenses by `spent_on`:
 * - `packageIncomeSatang`: Σ `total_satang` of `paid` package_orders (VAT included);
 * - `cashIncomeSatang`: Σ cash_payments `amount_satang` (ADR 0010, as recorded; no VAT split);
 * - `incomeSatang` = package + cash; `vatSatang`: Σ `vat_satang` of those orders;
 *   `netIncomeSatang` = income − VAT;
 * - `manualExpenseSatang`: Σ live `expenses`; `estimatedCostSatang`: the running-cost estimate
 *   (ADR 0019 constants: R2 storage above the free GB at the current bucket size, VPS_MONTH_THB,
 *   USD_THB) spread evenly per day over the range, a label "ประมาณการ" in the UI;
 *   `expenseSatang` = manual + estimated;
 * - `profitSatang` = net income − expenses (VAT is owed, not earned; negative is a loss);
 * - `ordersPaid`: paid orders; `buyers`: distinct photographers with a paid order;
 *   `freeSignups`: Free sign-ups (`account.self_signup` audit rows); `paidSignups`: paid orders
 *   that created the account (`account_created`).
 */
export const financeTotalsSchema = z
  .object({
    incomeSatang: satangTotalSchema,
    packageIncomeSatang: satangTotalSchema,
    cashIncomeSatang: satangTotalSchema,
    vatSatang: satangTotalSchema,
    netIncomeSatang: satangTotalSchema,
    manualExpenseSatang: satangTotalSchema,
    estimatedCostSatang: satangTotalSchema,
    expenseSatang: satangTotalSchema,
    profitSatang: signedSatangSchema,
    ordersPaid: count,
    buyers: count,
    freeSignups: count,
    paidSignups: count,
  })
  .refine((t) => t.incomeSatang === t.packageIncomeSatang + t.cashIncomeSatang, {
    error: 'incomeSatang must be packageIncomeSatang + cashIncomeSatang',
  })
  .refine((t) => t.netIncomeSatang === t.incomeSatang - t.vatSatang, {
    error: 'netIncomeSatang must be incomeSatang - vatSatang',
  })
  .refine((t) => t.expenseSatang === t.manualExpenseSatang + t.estimatedCostSatang, {
    error: 'expenseSatang must be manualExpenseSatang + estimatedCostSatang',
  })
  .refine((t) => t.profitSatang === t.netIncomeSatang - t.expenseSatang, {
    error: 'profitSatang must be netIncomeSatang - expenseSatang',
  });
export type FinanceTotals = z.output<typeof financeTotalsSchema>;

/** One bucket of the chart (financeBucketKeys; zero-filled). */
export const financeSeriesPointSchema = z.object({
  /** `YYYY-MM-DD` (day) or `YYYY-MM` (month), Bangkok. */
  bucket: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  packageIncomeSatang: satangTotalSchema,
  cashIncomeSatang: satangTotalSchema,
  /**
   * Σ `vat_satang` of the paid package orders in the bucket (part of packageIncomeSatang), so a
   * bucket's profit is package + cash − VAT − manual − estimated, as the totals'. Σ over the
   * series is `totals.vatSatang`.
   */
  vatSatang: satangTotalSchema,
  manualExpenseSatang: satangTotalSchema,
  estimatedCostSatang: satangTotalSchema,
});
export type FinanceSeriesPoint = z.output<typeof financeSeriesPointSchema>;

/** Paid orders of one package in the range (packages without one are left out). */
export const financePackageMixSchema = z.object({
  code: packageCodeSchema,
  name: z.string().min(1),
  orders: count,
  /** Σ `total_satang` (VAT included). */
  incomeSatang: satangTotalSchema,
});
export type FinancePackageMix = z.output<typeof financePackageMixSchema>;

/**
 * A top customer of the range: paid package orders plus cash payments. Ordered by `paidSatang`
 * DESC, then `userId`; at most FINANCE_TOP_CUSTOMERS.
 */
export const financeTopCustomerSchema = z.object({
  userId: idSchema,
  email: z.string().nullable(),
  name: z.string().nullable(),
  /** Paid package orders (cash payments are not orders). */
  orders: count,
  /** Σ order `total_satang` + Σ cash `amount_satang`. */
  paidSatang: satangTotalSchema,
});
export type FinanceTopCustomer = z.output<typeof financeTopCustomerSchema>;

export const financeResponseSchema = z
  .object({
    /** The range answered, defaults applied (resolveFinanceRange). */
    range: z.object({
      from: bangkokDateSchema,
      to: bangkokDateSchema,
      bucket: z.enum(FINANCE_BUCKETS),
    }),
    totals: financeTotalsSchema,
    series: z.array(financeSeriesPointSchema),
    packageMix: z.array(financePackageMixSchema),
    topCustomers: z.array(financeTopCustomerSchema).max(FINANCE_TOP_CUSTOMERS),
  })
  .refine((f) => f.series.reduce((sum, p) => sum + p.vatSatang, 0) === f.totals.vatSatang, {
    error: 'the series VAT must add up to totals.vatSatang',
    path: ['series'],
  });
export type FinanceResponse = z.output<typeof financeResponseSchema>;

// --- GET /admin/users/:id/finance (§4) ------------------------------------------------------------

/** Most orders GET /admin/users/:id/finance lists (newest first); the totals cover all of them. */
export const ADMIN_USER_FINANCE_MAX_ORDERS = 100;

/** One package order of the user (any status). Amounts as stored (packageTotal). */
export const adminUserFinanceOrderSchema = z.object({
  id: idSchema,
  packageCode: packageCodeSchema,
  packageName: z.string().min(1),
  status: z.enum(PACKAGE_ORDER_STATUSES),
  /** VAT included. */
  totalSatang: satangTotalSchema,
  vatSatang: satangTotalSchema,
  createdAt: isoDateTimeSchema,
  paidAt: isoDateTimeSchema.nullable(),
});
export type AdminUserFinanceOrder = z.output<typeof adminUserFinanceOrderSchema>;

/**
 * GET /admin/users/:id/finance: what one photographer paid and is estimated to cost. Admins and
 * viewers are NOT_FOUND.
 * - `orders`: their package_orders (`photographer_id`), every status, newest first, at most
 *   ADMIN_USER_FINANCE_MAX_ORDERS;
 * - `ordersPaid`, `paidSatang`: count and Σ `total_satang` (VAT included) of all their paid
 *   orders; `netPaidSatang`: Σ (`total_satang` − `vat_satang`) of those orders (ex VAT);
 *   `cashPaidSatang`: Σ their cash_payments;
 * - `firstPaidAt` / `lastPaidAt`: earliest / latest `paid_at` over paid orders and cash payments
 *   (null: never paid);
 * - `usage`: `storageBytes` (storage_usage.used_bytes), `bytesServed` (Σ daily_stats.bytes_out),
 *   `photosUploaded` (image files not in the trash, as adminUser.photoCount);
 * - `estimatedCostSatang`: an allocation, not a bill (the UI says "ประมาณการ"): the platform's
 *   monthly estimate (ADR 0019) shared by the user's share of stored bytes (`storage`) and of
 *   bytes served (`server`), accrued per day from the account's creation to now;
 *   `total` = storage + server;
 * - `profitSatang` = net paid (ex VAT) + cash − total cost (ADR 0027 §4, owner 2026-11-16): the
 *   same basis as the finance summary's profit (net income − expenses), since VAT is owed, not
 *   earned.
 */
export const adminUserFinanceResponseSchema = z
  .object({
    orders: z.array(adminUserFinanceOrderSchema).max(ADMIN_USER_FINANCE_MAX_ORDERS),
    ordersPaid: count,
    paidSatang: satangTotalSchema,
    netPaidSatang: satangTotalSchema,
    cashPaidSatang: satangTotalSchema,
    firstPaidAt: isoDateTimeSchema.nullable(),
    lastPaidAt: isoDateTimeSchema.nullable(),
    usage: z.object({
      storageBytes: byteCountSchema,
      bytesServed: byteCountSchema,
      photosUploaded: count,
    }),
    estimatedCostSatang: z
      .object({
        storage: satangTotalSchema,
        server: satangTotalSchema,
        total: satangTotalSchema,
      })
      .refine((c) => c.total === c.storage + c.server, {
        error: 'total must be storage + server',
      }),
    profitSatang: signedSatangSchema,
  })
  .refine((f) => f.netPaidSatang <= f.paidSatang, {
    error: 'netPaidSatang must not exceed paidSatang',
  })
  .refine(
    (f) => f.profitSatang === f.netPaidSatang + f.cashPaidSatang - f.estimatedCostSatang.total,
    { error: 'profitSatang must be netPaidSatang + cashPaidSatang - estimatedCostSatang.total' },
  )
  .refine((f) => (f.firstPaidAt === null) === (f.lastPaidAt === null), {
    error: 'firstPaidAt and lastPaidAt are set together',
  });
export type AdminUserFinanceResponse = z.output<typeof adminUserFinanceResponseSchema>;
