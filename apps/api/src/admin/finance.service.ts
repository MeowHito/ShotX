import { Inject, Injectable } from '@nestjs/common';
import {
  auditLog,
  cashPayments,
  dailyStats,
  expenses,
  files,
  packageOrders,
  packages,
  storageUsage,
  users,
} from '@shotx/db';
import {
  ADMIN_USER_FINANCE_MAX_ORDERS,
  type AdminUserFinanceResponse,
  bangkokDate,
  bangkokRangeInstants,
  FINANCE_TOP_CUSTOMERS,
  financeBucketKeys,
  type FinanceBucket,
  type FinanceResponse,
  type FinanceSeriesPoint,
  resolveFinanceRange,
} from '@shotx/shared';
import { type SQL, sql } from 'drizzle-orm';
import { type Db, rows } from '../db/db';
import { notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { CLOCK, type Clock, DATABASE } from '../tokens';
import { allocateUserCost, monthlyTotal, spreadEstimate } from './finance-math';
import { AdminSystemService } from './system.service';

// Admin finance (ADR 0027 §3, §4). Read-only, not audited. Every sum is done in SQL (grouped by
// Bangkok bucket); JS only walks the range's buckets and days. Money is integer satang; sums come
// back as text (bigint) and are converted once.

const TZ = sql.raw(`'Asia/Bangkok'`);

/** to_char pattern of a bucket key (financeBucketKeys: `YYYY-MM-DD` or `YYYY-MM`). */
const bucketFormat = (bucket: FinanceBucket) => (bucket === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM');

const num = (text: string | number | null | undefined) => Number(text ?? 0);

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

@Injectable()
export class FinanceService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AdminSystemService) private readonly system: AdminSystemService,
  ) {}

  /** GET /admin/finance. An invalid range after defaults: VALIDATION_FAILED. */
  async summary(query: {
    from?: string | undefined;
    to?: string | undefined;
    bucket?: FinanceBucket | undefined;
  }): Promise<FinanceResponse> {
    const today = bangkokDate(this.clock.now());
    const range = resolveFinanceRange(query, today);
    if (range === null) {
      throw validationError(['query', query.from === undefined ? 'to' : 'from'], 'Invalid range');
    }
    const { start, end } = bangkokRangeInstants(range.from, range.to);
    const startAt = sql`${start.toISOString()}::timestamptz`;
    const endAt = sql`${end.toISOString()}::timestamptz`;
    const fmt = bucketFormat(range.bucket);
    const paidOrder: SQL = sql`${packageOrders.status} = 'paid'
      AND ${packageOrders.paidAt} >= ${startAt} AND ${packageOrders.paidAt} < ${endAt}`;
    const cashInRange: SQL = sql`${cashPayments.paidAt} >= ${startAt}
      AND ${cashPayments.paidAt} < ${endAt}`;

    const [orderBuckets, cashBuckets, expenseBuckets, counts, signups, mix, top, cost] =
      await Promise.all([
        rows<{ bucket: string; total: string; vat: string }>(
          this.db,
          sql`SELECT to_char(${packageOrders.paidAt} AT TIME ZONE ${TZ}, ${fmt}) AS bucket,
                     sum(${packageOrders.totalSatang})::text AS total,
                     sum(${packageOrders.vatSatang})::text AS vat
              FROM ${packageOrders} WHERE ${paidOrder} GROUP BY 1`,
        ),
        rows<{ bucket: string; total: string }>(
          this.db,
          sql`SELECT to_char(${cashPayments.paidAt} AT TIME ZONE ${TZ}, ${fmt}) AS bucket,
                     sum(${cashPayments.amountSatang})::text AS total
              FROM ${cashPayments} WHERE ${cashInRange} GROUP BY 1`,
        ),
        rows<{ bucket: string; total: string }>(
          this.db,
          sql`SELECT to_char(${expenses.spentOn}::timestamp, ${fmt}) AS bucket,
                     sum(${expenses.amountSatang})::text AS total
              FROM ${expenses}
              WHERE ${expenses.deletedAt} IS NULL
                AND ${expenses.spentOn} >= ${range.from}::date
                AND ${expenses.spentOn} <= ${range.to}::date
              GROUP BY 1`,
        ),
        rows<{ orders: number; buyers: number; paid_signups: number }>(
          this.db,
          sql`SELECT count(*)::int AS orders,
                     count(DISTINCT ${packageOrders.photographerId})::int AS buyers,
                     (count(*) FILTER (WHERE ${packageOrders.accountCreated}))::int AS paid_signups
              FROM ${packageOrders} WHERE ${paidOrder}`,
        ),
        rows<{ n: number }>(
          this.db,
          sql`SELECT count(*)::int AS n FROM ${auditLog}
              WHERE ${auditLog.action} = 'account.self_signup'
                AND ${auditLog.createdAt} >= ${startAt} AND ${auditLog.createdAt} < ${endAt}`,
        ),
        rows<{ code: string; name: string; orders: number; income: string }>(
          this.db,
          sql`SELECT ${packages.code} AS code, ${packages.name} AS name,
                     count(*)::int AS orders, sum(${packageOrders.totalSatang})::text AS income
              FROM ${packageOrders} JOIN ${packages} ON ${packages.id} = ${packageOrders.packageId}
              WHERE ${paidOrder}
              GROUP BY ${packages.code}, ${packages.name}
              ORDER BY sum(${packageOrders.totalSatang}) DESC, ${packages.code}`,
        ),
        rows<{
          user_id: string;
          email: string | null;
          name: string | null;
          orders: number;
          paid: string;
        }>(
          this.db,
          sql`WITH paid AS (
                SELECT ${packageOrders.photographerId} AS user_id, 1 AS orders,
                       ${packageOrders.totalSatang} AS amount
                FROM ${packageOrders}
                WHERE ${paidOrder} AND ${packageOrders.photographerId} IS NOT NULL
                UNION ALL
                SELECT ${cashPayments.photographerId}, 0, ${cashPayments.amountSatang}
                FROM ${cashPayments} WHERE ${cashInRange}
              )
              SELECT paid.user_id, ${users.email} AS email, ${users.name} AS name,
                     sum(paid.orders)::int AS orders, sum(paid.amount)::text AS paid
              FROM paid JOIN ${users} ON ${users.id} = paid.user_id
              GROUP BY paid.user_id, ${users.email}, ${users.name}
              ORDER BY sum(paid.amount) DESC, paid.user_id
              LIMIT ${FINANCE_TOP_CUSTOMERS}`,
        ),
        this.system.monthlyCost(),
      ]);

    const byKey = <R extends { bucket: string }>(list: R[]) =>
      new Map(list.map((r) => [r.bucket, r]));
    const orderBy = byKey(orderBuckets);
    const cashBy = byKey(cashBuckets);
    const expenseBy = byKey(expenseBuckets);
    const estimate = spreadEstimate(range, today, monthlyTotal(cost));
    const series: FinanceSeriesPoint[] = financeBucketKeys(range).map((bucket) => ({
      bucket,
      packageIncomeSatang: num(orderBy.get(bucket)?.total),
      cashIncomeSatang: num(cashBy.get(bucket)?.total),
      vatSatang: num(orderBy.get(bucket)?.vat),
      manualExpenseSatang: num(expenseBy.get(bucket)?.total),
      estimatedCostSatang: estimate.get(bucket) ?? 0,
    }));

    const sum = (pick: (p: FinanceSeriesPoint) => number) =>
      series.reduce((total, point) => total + pick(point), 0);
    const packageIncomeSatang = sum((p) => p.packageIncomeSatang);
    const cashIncomeSatang = sum((p) => p.cashIncomeSatang);
    const vatSatang = sum((p) => p.vatSatang);
    const incomeSatang = packageIncomeSatang + cashIncomeSatang;
    const netIncomeSatang = incomeSatang - vatSatang;
    const manualExpenseSatang = sum((p) => p.manualExpenseSatang);
    const estimatedCostSatang = sum((p) => p.estimatedCostSatang);
    const expenseSatang = manualExpenseSatang + estimatedCostSatang;
    return {
      range,
      totals: {
        incomeSatang,
        packageIncomeSatang,
        cashIncomeSatang,
        vatSatang,
        netIncomeSatang,
        manualExpenseSatang,
        estimatedCostSatang,
        expenseSatang,
        profitSatang: netIncomeSatang - expenseSatang,
        ordersPaid: counts[0]?.orders ?? 0,
        buyers: counts[0]?.buyers ?? 0,
        freeSignups: signups[0]?.n ?? 0,
        paidSignups: counts[0]?.paid_signups ?? 0,
      },
      series,
      packageMix: mix.map((m) => ({
        code: m.code,
        name: m.name,
        orders: m.orders,
        incomeSatang: num(m.income),
      })),
      topCustomers: top.map((t) => ({
        userId: t.user_id,
        email: t.email,
        name: t.name,
        orders: t.orders,
        paidSatang: num(t.paid),
      })),
    };
  }

  /**
   * GET /admin/users/:id/finance. Only photographers have one: admins, viewers and unknown ids are
   * NOT_FOUND (the contract). Cost allocation: allocateUserCost (finance-math.ts).
   */
  async user(id: string): Promise<AdminUserFinanceResponse> {
    const [account] = await rows<{ role: string; created_at: Date | string }>(
      this.db,
      sql`SELECT ${users.role} AS role, ${users.createdAt} AS created_at
          FROM ${users} WHERE ${users.id} = ${id}::uuid`,
    );
    if (account?.role !== 'photographer') throw notFound('User');
    const now = this.clock.now();

    const [orders, orderTotals, cashTotals, usage, platform, cost] = await Promise.all([
      rows<{
        id: string;
        code: string;
        name: string;
        status: 'pending' | 'paid' | 'failed' | 'amount_mismatch';
        total: number;
        vat: number;
        created_at: Date | string;
        paid_at: Date | string | null;
      }>(
        this.db,
        sql`SELECT ${packageOrders.id} AS id, ${packages.code} AS code, ${packages.name} AS name,
                   ${packageOrders.status} AS status, ${packageOrders.totalSatang} AS total,
                   ${packageOrders.vatSatang} AS vat, ${packageOrders.createdAt} AS created_at,
                   ${packageOrders.paidAt} AS paid_at
            FROM ${packageOrders} JOIN ${packages} ON ${packages.id} = ${packageOrders.packageId}
            WHERE ${packageOrders.photographerId} = ${id}::uuid
            ORDER BY ${packageOrders.createdAt} DESC, ${packageOrders.id} DESC
            LIMIT ${ADMIN_USER_FINANCE_MAX_ORDERS}`,
      ),
      rows<{
        orders: number;
        paid: string;
        net: string;
        first: Date | string | null;
        last: Date | string | null;
      }>(
        this.db,
        sql`SELECT count(*)::int AS orders,
                   coalesce(sum(${packageOrders.totalSatang}), 0)::text AS paid,
                   coalesce(sum(${packageOrders.totalSatang} - ${packageOrders.vatSatang}), 0)::text AS net,
                   min(${packageOrders.paidAt}) AS first, max(${packageOrders.paidAt}) AS last
            FROM ${packageOrders}
            WHERE ${packageOrders.photographerId} = ${id}::uuid AND ${packageOrders.status} = 'paid'`,
      ),
      rows<{ paid: string; first: Date | string | null; last: Date | string | null }>(
        this.db,
        sql`SELECT coalesce(sum(${cashPayments.amountSatang}), 0)::text AS paid,
                   min(${cashPayments.paidAt}) AS first, max(${cashPayments.paidAt}) AS last
            FROM ${cashPayments} WHERE ${cashPayments.photographerId} = ${id}::uuid`,
      ),
      rows<{ storage: string; served: string; photos: number }>(
        this.db,
        sql`SELECT
              (SELECT coalesce(max(${storageUsage.usedBytes}), 0)::text FROM ${storageUsage}
                WHERE ${storageUsage.photographerId} = ${id}::uuid) AS storage,
              (SELECT coalesce(sum(${dailyStats.bytesOut}), 0)::text FROM ${dailyStats}
                WHERE ${dailyStats.photographerId} = ${id}::uuid) AS served,
              (SELECT count(*)::int FROM ${files}
                WHERE ${files.ownerId} = ${id}::uuid AND ${files.deletedAt} IS NULL
                  AND ${files.status} IN ('processing', 'ready')
                  AND ${files.mime} LIKE 'image/%') AS photos`,
      ),
      rows<{ storage: string; served: string }>(
        this.db,
        sql`SELECT
              (SELECT coalesce(sum(${storageUsage.usedBytes}), 0)::text FROM ${storageUsage}) AS storage,
              (SELECT coalesce(sum(${dailyStats.bytesOut}), 0)::text FROM ${dailyStats}) AS served`,
      ),
      this.system.monthlyCost(),
    ]);

    const o = orderTotals[0];
    const c = cashTotals[0];
    const u = usage[0];
    const p = platform[0];
    const paidAts = [o?.first, o?.last, c?.first, c?.last]
      .filter((t): t is Date | string => t !== null && t !== undefined)
      .map((t) => new Date(t).getTime());
    const storageBytes = num(u?.storage);
    const bytesServed = num(u?.served);
    const estimatedCostSatang = allocateUserCost({
      cost,
      userStorageBytes: storageBytes,
      totalStorageBytes: num(p?.storage),
      userBytesServed: bytesServed,
      totalBytesServed: num(p?.served),
      createdOn: bangkokDate(new Date(account.created_at)),
      today: bangkokDate(now),
    });
    const paidSatang = num(o?.paid);
    const netPaidSatang = num(o?.net);
    const cashPaidSatang = num(c?.paid);
    return {
      orders: orders.map((row) => ({
        id: row.id,
        packageCode: row.code,
        packageName: row.name,
        status: row.status,
        totalSatang: num(row.total),
        vatSatang: num(row.vat),
        createdAt: new Date(row.created_at).toISOString(),
        paidAt: iso(row.paid_at),
      })),
      ordersPaid: o?.orders ?? 0,
      paidSatang,
      netPaidSatang,
      cashPaidSatang,
      firstPaidAt: paidAts.length === 0 ? null : new Date(Math.min(...paidAts)).toISOString(),
      lastPaidAt: paidAts.length === 0 ? null : new Date(Math.max(...paidAts)).toISOString(),
      usage: { storageBytes, bytesServed, photosUploaded: u?.photos ?? 0 },
      estimatedCostSatang,
      // ADR 0027 §4 (owner 2026-11-16): net package income (ex VAT) + cash − estimated cost.
      profitSatang: netPaidSatang + cashPaidSatang - estimatedCostSatang.total,
    };
  }
}
