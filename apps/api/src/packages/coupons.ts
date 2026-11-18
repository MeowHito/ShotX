import { packageCoupons, packageOrders } from '@shotx/db';
import { ErrorCode } from '@shotx/shared';
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Queryable } from '../db/db';
import { ApiError } from '../http/api-error';

// Coupons (ADR 0030). A coupon's uses are counted from package_orders, never stored: paid orders,
// plus pending or failed ones younger than PACKAGE_COUPON_HOLD_SECONDS (each holds one use while
// the buyer pays). A paid order always counts, also one paid after its hold ended.

export type CouponRow = typeof packageCoupons.$inferSelect;

export interface CouponUses {
  paid: number;
  holding: number;
}

export const couponInvalid = () =>
  new ApiError(ErrorCode.COUPON_INVALID, 'This coupon code can not be used');

export const couponUsedUp = () =>
  new ApiError(ErrorCode.COUPON_USED_UP, 'This coupon has been used up');

/** The uses of each coupon in `ids` (missing ids: none). */
export async function couponUses(
  q: Queryable,
  ids: readonly string[],
  now: Date,
  holdSeconds: number,
): Promise<Map<string, CouponUses>> {
  const out = new Map<string, CouponUses>();
  if (ids.length === 0) return out;
  const holdFrom = new Date(now.getTime() - holdSeconds * 1000);
  const rows = await q
    .select({
      couponId: packageOrders.couponId,
      paid: sql<number>`count(*) FILTER (WHERE ${packageOrders.status} = 'paid')::int`,
      holding: sql<number>`count(*) FILTER (WHERE ${packageOrders.status} IN ('pending', 'failed'))::int`,
    })
    .from(packageOrders)
    .where(
      and(
        inArray(packageOrders.couponId, [...ids]),
        or(
          eq(packageOrders.status, 'paid'),
          and(
            inArray(packageOrders.status, ['pending', 'failed']),
            gt(packageOrders.createdAt, holdFrom),
          ),
        ),
      ),
    )
    .groupBy(packageOrders.couponId);
  for (const row of rows) {
    if (row.couponId !== null) out.set(row.couponId, { paid: row.paid, holding: row.holding });
  }
  return out;
}

/**
 * The coupon of `code` (already upper-cased) when it can be used now: COUPON_INVALID when it is
 * unknown, switched off or expired; COUPON_USED_UP when its uses are all taken. `lock` takes the
 * row FOR UPDATE, so two orders in parallel can't both take the last use (call it in the order
 * insert's transaction).
 */
export async function usableCoupon(
  q: Queryable,
  code: string,
  now: Date,
  holdSeconds: number,
  options: { lock?: boolean } = {},
): Promise<CouponRow> {
  const query = q.select().from(packageCoupons).where(eq(packageCoupons.code, code)).limit(1);
  const [coupon] = options.lock === true ? await query.for('update') : await query;
  if (
    coupon === undefined ||
    !coupon.isActive ||
    (coupon.expiresAt !== null && coupon.expiresAt.getTime() <= now.getTime())
  ) {
    throw couponInvalid();
  }
  const uses = (await couponUses(q, [coupon.id], now, holdSeconds)).get(coupon.id);
  if ((uses?.paid ?? 0) + (uses?.holding ?? 0) >= coupon.maxRedemptions) throw couponUsedUp();
  return coupon;
}
