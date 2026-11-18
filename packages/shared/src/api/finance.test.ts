import { describe, expect, it } from 'vitest';
import {
  ADMIN_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  AUTH_AUDIT_ACTIONS,
  EXPENSE_CATEGORIES,
  FINANCE_AUDIT_ACTIONS,
  isAuditAction,
  PACKAGE_AUDIT_ACTIONS,
} from '../domain';
import { adminUserSchema } from './admin';
import {
  addBangkokDays,
  adminUserFinanceResponseSchema,
  AUDIT_ACTION_FILTER_MAX_VALUES,
  auditLogEntrySchema,
  bangkokDaysBetween,
  bangkokRangeInstants,
  createExpenseBodySchema,
  decodeAuditLogCursor,
  decodeExpenseCursor,
  encodeAuditLogCursor,
  encodeExpenseCursor,
  EXPENSE_MAX_SATANG,
  EXPENSE_NOTE_MAX_LENGTH,
  expenseSchema,
  FINANCE_AUDIT_META_SCHEMAS,
  FINANCE_MAX_DAYS_BY_DAY,
  FINANCE_TOP_CUSTOMERS,
  financeBucketKeys,
  financeQuerySchema,
  financeResponseSchema,
  financeTotalsSchema,
  isAuditActionPrefix,
  listAuditLogQuerySchema,
  listExpensesQuerySchema,
  resolveFinanceRange,
} from './finance';
import { ADMIN_ROUTES, apiPath } from './routes';

const id = '0195f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f1a';
const otherId = '0195f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f1b';

describe('audit actions (ADR 0027)', () => {
  it('lists every group once, finance included', () => {
    expect(AUDIT_ACTIONS).toEqual([
      ...AUTH_AUDIT_ACTIONS,
      ...ADMIN_AUDIT_ACTIONS,
      ...PACKAGE_AUDIT_ACTIONS,
      ...FINANCE_AUDIT_ACTIONS,
    ]);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(FINANCE_AUDIT_ACTIONS).toEqual([
      'finance.expense_created',
      'finance.expense_deleted',
      'finance.coupon_created',
      'finance.coupon_updated',
    ]);
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'auth.photographer.sign_in',
        'admin.cash_payment.created',
        'account.self_signup',
        'package.order_paid',
      ]),
    );
  });

  it('every action is a valid exact filter, and its prefix a valid prefix filter', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(listAuditLogQuerySchema.safeParse({ action }).success, action).toBe(true);
      expect(isAuditActionPrefix(action)).toBe(false);
      const prefix = `${action.split('.')[0]}.`;
      expect(listAuditLogQuerySchema.safeParse({ action: prefix }).success, prefix).toBe(true);
      expect(isAuditActionPrefix(prefix)).toBe(true);
    }
  });

  it('isAuditAction tells known actions from others', () => {
    expect(isAuditAction('finance.expense_deleted')).toBe(true);
    expect(isAuditAction('takedown.share')).toBe(false);
  });

  it('types the finance metas', () => {
    const meta = { spentOn: '2026-11-16', amountSatang: 129_900, category: 'server' };
    expect(FINANCE_AUDIT_META_SCHEMAS['finance.expense_created'].parse(meta)).toEqual(meta);
    expect(FINANCE_AUDIT_META_SCHEMAS['finance.expense_deleted'].parse(meta)).toEqual(meta);
    expect(
      FINANCE_AUDIT_META_SCHEMAS['finance.expense_created'].safeParse({ ...meta, amountSatang: 0 })
        .success,
    ).toBe(false);
  });
});

describe('GET /admin/audit-log', () => {
  it('accepts filters and refuses bad ones', () => {
    expect(
      listAuditLogQuerySchema.parse({
        action: 'package.',
        actorId: id,
        targetId: ' abc ',
        from: '2026-11-01',
        to: '2026-11-16',
        limit: '20',
      }),
    ).toEqual({
      action: ['package.'],
      actorId: id,
      targetId: 'abc',
      from: '2026-11-01',
      to: '2026-11-16',
      limit: 20,
    });
    for (const bad of [
      { action: 'Admin.user' },
      { action: 'admin..user' },
      { action: '.admin' },
      { action: 'admin.%' },
      { actorId: 'not-a-uuid' },
      { targetId: '' },
      { from: '2026-11-16', to: '2026-11-01' },
      { from: '16/11/2026' },
      { limit: '0' },
    ]) {
      expect(listAuditLogQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('takes several action filters, comma-separated and/or repeated', () => {
    const action = (value: string | string[]) =>
      listAuditLogQuerySchema.parse({ action: value }).action;
    expect(action('package.,account.self_signup')).toEqual(['package.', 'account.self_signup']);
    expect(action(['package.', 'account.self_signup'])).toEqual([
      'package.',
      'account.self_signup',
    ]);
    expect(action(['package., auth.', 'package.'])).toEqual(['package.', 'auth.']);
    const max = Array.from({ length: AUDIT_ACTION_FILTER_MAX_VALUES }, (_, i) => `a${i}.`);
    expect(action(max.join(','))).toEqual(max);
    for (const bad of [
      '',
      'package.,',
      ',package.',
      'package.,admin.%',
      [...max, 'b.'].join(','),
      [],
    ]) {
      expect(listAuditLogQuerySchema.safeParse({ action: bad }).success, String(bad)).toBe(false);
    }
  });

  it('round-trips its cursor and rejects junk', () => {
    const cursor = { v: 1 as const, createdAt: '2026-11-16 10:00:00.123456+07', id };
    expect(decodeAuditLogCursor(encodeAuditLogCursor(cursor))).toEqual(cursor);
    expect(decodeAuditLogCursor('junk')).toBeNull();
  });

  it('parses an entry with a null actor and raw meta', () => {
    const entry = {
      id,
      createdAt: '2026-11-16T03:00:00.000Z',
      action: 'package.order_amount_mismatch',
      actorId: null,
      actorEmail: null,
      targetType: 'package_order',
      targetId: otherId,
      targetEmail: null,
      meta: { orderId: otherId, paidSatang: 100 },
    };
    expect(auditLogEntrySchema.parse(entry)).toEqual(entry);
  });

  it('turns Bangkok days into instants', () => {
    const { start, end } = bangkokRangeInstants('2026-11-01', '2026-11-16');
    expect(start.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-16T17:00:00.000Z');
  });
});

describe('expenses', () => {
  it('validates a new expense', () => {
    expect(
      createExpenseBodySchema.parse({
        spentOn: '2026-11-16',
        amountSatang: 50_000,
        category: 'domain',
        note: '  snap.action.in.th  ',
      }),
    ).toEqual({
      spentOn: '2026-11-16',
      amountSatang: 50_000,
      category: 'domain',
      note: 'snap.action.in.th',
    });
    expect(
      createExpenseBodySchema.parse({
        spentOn: '2026-11-16',
        amountSatang: 1,
        category: 'other',
        note: ' ',
      }).note,
    ).toBeUndefined();
    const ok = { spentOn: '2026-11-16', amountSatang: 1, category: 'server' };
    for (const bad of [
      { ...ok, amountSatang: 0 },
      { ...ok, amountSatang: 1.5 },
      { ...ok, amountSatang: EXPENSE_MAX_SATANG + 1 },
      { ...ok, category: 'rent' },
      { ...ok, spentOn: '2026-02-30' },
      { ...ok, note: 'x'.repeat(EXPENSE_NOTE_MAX_LENGTH + 1) },
      { ...ok, recordedById: id },
    ]) {
      expect(createExpenseBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('has the categories of the ADR', () => {
    expect(EXPENSE_CATEGORIES).toEqual([
      'server',
      'storage',
      'payment_fee',
      'domain',
      'email',
      'marketing',
      'other',
    ]);
    expect(
      expenseSchema.parse({
        id,
        spentOn: '2026-11-16',
        amountSatang: 100,
        category: 'email',
        note: null,
        recordedById: otherId,
        createdAt: '2026-11-16T03:00:00Z',
      }).category,
    ).toBe('email');
  });

  it('lists with an optional range and a cursor', () => {
    expect(listExpensesQuerySchema.parse({})).toEqual({});
    expect(
      listExpensesQuerySchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success,
    ).toBe(false);
    const cursor = { v: 1 as const, spentOn: '2026-11-16', id };
    expect(decodeExpenseCursor(encodeExpenseCursor(cursor))).toEqual(cursor);
    expect(decodeExpenseCursor(encodeAuditLogCursor({ v: 1, createdAt: 'x', id }))).toBeNull();
  });
});

describe('GET /admin/finance', () => {
  it('defaults to the last 30 days by day', () => {
    expect(resolveFinanceRange(financeQuerySchema.parse({}), '2026-11-16')).toEqual({
      from: '2026-10-18',
      to: '2026-11-16',
      bucket: 'day',
    });
    expect(resolveFinanceRange({ to: '2026-03-01' }, '2026-11-16')).toEqual({
      from: '2026-01-31',
      to: '2026-03-01',
      bucket: 'day',
    });
    expect(resolveFinanceRange({ from: '2026-11-01', bucket: 'month' }, '2026-11-16')).toEqual({
      from: '2026-11-01',
      to: '2026-11-16',
      bucket: 'month',
    });
    // Only a future `from`: from after to.
    expect(resolveFinanceRange({ from: '2026-12-01' }, '2026-11-16')).toBeNull();
  });

  it('limits the range per bucket', () => {
    const from = '2025-01-01';
    const lastDay = addBangkokDays(from, FINANCE_MAX_DAYS_BY_DAY - 1);
    expect(financeQuerySchema.safeParse({ from, to: lastDay }).success).toBe(true);
    expect(financeQuerySchema.safeParse({ from, to: addBangkokDays(lastDay, 1) }).success).toBe(
      false,
    );
    expect(
      financeQuerySchema.safeParse({ from, to: addBangkokDays(lastDay, 1), bucket: 'month' })
        .success,
    ).toBe(true);
    expect(financeQuerySchema.safeParse({ bucket: 'week' }).success).toBe(false);
    expect(resolveFinanceRange({ from: '2020-01-01' }, '2026-11-16')).toBeNull();
    expect(
      resolveFinanceRange({ from: '2020-01-01', bucket: 'month' }, '2026-11-16'),
    ).not.toBeNull();
  });

  it('builds zero-fill bucket keys', () => {
    expect(financeBucketKeys({ from: '2026-02-27', to: '2026-03-02', bucket: 'day' })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(financeBucketKeys({ from: '2025-11-30', to: '2026-02-01', bucket: 'month' })).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(bangkokDaysBetween('2024-02-28', '2024-03-01')).toBe(2);
  });

  const totals = {
    incomeSatang: 152_693,
    packageIncomeSatang: 42_693,
    cashIncomeSatang: 110_000,
    vatSatang: 2_793,
    netIncomeSatang: 149_900,
    manualExpenseSatang: 50_000,
    estimatedCostSatang: 120_000,
    expenseSatang: 170_000,
    profitSatang: -20_100,
    ordersPaid: 1,
    buyers: 1,
    freeSignups: 3,
    paidSignups: 1,
  };

  it('ties the totals together (a loss is negative)', () => {
    expect(financeTotalsSchema.parse(totals)).toEqual(totals);
    for (const broken of [
      { incomeSatang: 1 },
      { netIncomeSatang: 1 },
      { expenseSatang: 1 },
      { profitSatang: 0 },
      { vatSatang: -1 },
    ]) {
      expect(financeTotalsSchema.safeParse({ ...totals, ...broken }).success).toBe(false);
    }
  });

  it('parses a full response', () => {
    const response = {
      range: { from: '2026-11-15', to: '2026-11-16', bucket: 'day' },
      totals,
      series: [
        {
          bucket: '2026-11-15',
          packageIncomeSatang: 0,
          cashIncomeSatang: 110_000,
          vatSatang: 0,
          manualExpenseSatang: 0,
          estimatedCostSatang: 60_000,
        },
        {
          bucket: '2026-11-16',
          packageIncomeSatang: 42_693,
          cashIncomeSatang: 0,
          vatSatang: 2_793,
          manualExpenseSatang: 50_000,
          estimatedCostSatang: 60_000,
        },
      ],
      packageMix: [{ code: 'd3', name: '3 Days', orders: 1, incomeSatang: 42_693 }],
      topCustomers: [
        { userId: id, email: 'a@example.com', name: null, orders: 1, paidSatang: 42_693 },
      ],
    };
    expect(financeResponseSchema.parse(response)).toEqual(response);
    // The series VAT adds up to the totals' VAT.
    const [first, second] = response.series;
    expect(
      financeResponseSchema.safeParse({
        ...response,
        series: [first, { ...second, vatSatang: 2_792 }],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: FINANCE_TOP_CUSTOMERS + 1 }, () => response.topCustomers[0]);
    expect(financeResponseSchema.safeParse({ ...response, topCustomers: many }).success).toBe(
      false,
    );
  });
});

describe('GET /admin/users/:id/finance', () => {
  const finance = {
    orders: [
      {
        id,
        packageCode: 'd7',
        packageName: '7 Days',
        status: 'paid',
        totalSatang: 64_093,
        vatSatang: 4_193,
        createdAt: '2026-11-16T03:00:00Z',
        paidAt: '2026-11-16T03:01:00Z',
      },
      {
        id: otherId,
        packageCode: 'd3',
        packageName: '3 Days',
        status: 'failed',
        totalSatang: 42_693,
        vatSatang: 2_793,
        createdAt: '2026-11-15T03:00:00Z',
        paidAt: null,
      },
    ],
    ordersPaid: 1,
    paidSatang: 64_093,
    netPaidSatang: 59_900,
    cashPaidSatang: 0,
    firstPaidAt: '2026-11-16T03:01:00Z',
    lastPaidAt: '2026-11-16T03:01:00Z',
    usage: { storageBytes: 1_000_000, bytesServed: 5_000_000, photosUploaded: 12 },
    estimatedCostSatang: { storage: 100, server: 400, total: 500 },
    profitSatang: 59_400,
  };

  it('parses and checks the sums', () => {
    expect(adminUserFinanceResponseSchema.parse(finance)).toEqual(finance);
    expect(
      adminUserFinanceResponseSchema.safeParse({ ...finance, profitSatang: 64_093 }).success,
    ).toBe(false);
    // Profit is on net (ex VAT) package income, not the VAT-inclusive total.
    expect(
      adminUserFinanceResponseSchema.safeParse({ ...finance, profitSatang: 63_593 }).success,
    ).toBe(false);
    expect(
      adminUserFinanceResponseSchema.safeParse({ ...finance, netPaidSatang: 64_094 }).success,
    ).toBe(false);
    expect(
      adminUserFinanceResponseSchema.safeParse({
        ...finance,
        estimatedCostSatang: { storage: 100, server: 400, total: 400 },
      }).success,
    ).toBe(false);
    expect(adminUserFinanceResponseSchema.safeParse({ ...finance, lastPaidAt: null }).success).toBe(
      false,
    );
  });
});

describe('admin routes of ADR 0027', () => {
  it('are admin routes with the admins key', () => {
    for (const route of [
      ADMIN_ROUTES.auditLog,
      ADMIN_ROUTES.listExpenses,
      ADMIN_ROUTES.createExpense,
      ADMIN_ROUTES.deleteExpense,
      ADMIN_ROUTES.finance,
      ADMIN_ROUTES.userFinance,
    ]) {
      expect(route.auth).toBe('admin');
      expect(route.bffKey).toBe('admins');
      expect(route.errors).toEqual(expect.arrayContaining(['MFA_REQUIRED', 'ACCOUNT_DISABLED']));
    }
    expect(ADMIN_ROUTES.deleteExpense.status).toBe(204);
    expect(ADMIN_ROUTES.createExpense.status).toBe(201);
    expect(apiPath(ADMIN_ROUTES.userFinance, { id })).toBe(`/api/admin/users/${id}/finance`);
  });

  it('adds optional money fields to the users list', () => {
    const base = adminUserSchema.shape;
    expect(base.ordersPaid.safeParse(undefined).success).toBe(true);
    expect(base.ordersPaid.safeParse(null).success).toBe(true);
    expect(base.paidSatang.safeParse(42_693).success).toBe(true);
    expect(base.paidSatang.safeParse(-1).success).toBe(false);
  });
});
