import { Inject, Injectable } from '@nestjs/common';
import { packageCoupons } from '@shotx/db';
import {
  ADMIN_COUPON_LIST_LIMIT,
  type AdminCoupon,
  type FinanceAuditMeta,
  type ListCouponsResponse,
} from '@shotx/shared';
import { desc, eq } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import { type Db, isUniqueViolation, type Queryable } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { type CouponRow, type CouponUses, couponUses } from '../packages/coupons';
import { API_CONFIG, CLOCK, type Clock, DATABASE } from '../tokens';
import { writeFinanceAudit } from './admin-audit';

// Admin coupons (ADR 0030). Each write is in one transaction with its audit_log row
// (`finance.coupon_created` / `finance.coupon_updated`); coupons are never deleted.

function toCoupon(row: CouponRow, uses: CouponUses | undefined): AdminCoupon {
  return {
    id: row.id,
    code: row.code,
    percentOff: row.percentOff,
    maxRedemptions: row.maxRedemptions,
    paidCount: uses?.paid ?? 0,
    holdingCount: uses?.holding ?? 0,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    isActive: row.isActive,
    note: row.note,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class CouponsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async withUses(q: Queryable, rows: CouponRow[]): Promise<AdminCoupon[]> {
    const uses = await couponUses(
      q,
      rows.map((r) => r.id),
      this.clock.now(),
      this.config.packages.coupons.holdSeconds,
    );
    return rows.map((r) => toCoupon(r, uses.get(r.id)));
  }

  /** GET /admin/coupons: newest first, with their use counts. */
  async list(): Promise<ListCouponsResponse> {
    const rows = await this.db
      .select()
      .from(packageCoupons)
      .orderBy(desc(packageCoupons.createdAt), desc(packageCoupons.id))
      .limit(ADMIN_COUPON_LIST_LIMIT);
    return { items: await this.withUses(this.db, rows) };
  }

  /**
   * POST /admin/coupons: the row and `finance.coupon_created` in one transaction. A taken code is
   * CONFLICT; an expiry not in the future is VALIDATION_FAILED.
   */
  async create(
    actorId: string,
    body: {
      code: string;
      percentOff: number;
      maxRedemptions: number;
      expiresAt?: string | undefined;
      note?: string | undefined;
    },
  ): Promise<AdminCoupon> {
    const now = this.clock.now();
    const expiresAt = body.expiresAt === undefined ? null : new Date(body.expiresAt);
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      throw validationError(['body', 'expiresAt'], 'must be in the future');
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(packageCoupons)
          .values({
            code: body.code,
            percentOff: body.percentOff,
            maxRedemptions: body.maxRedemptions,
            expiresAt,
            note: body.note ?? null,
            createdById: actorId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (row === undefined) throw new Error('Inserted coupon vanished');
        await writeFinanceAudit(tx, {
          actorId,
          action: 'finance.coupon_created',
          target: 'coupon',
          targetId: row.id,
          meta: {
            code: row.code,
            percentOff: row.percentOff,
            maxRedemptions: row.maxRedemptions,
            expiresAt: row.expiresAt?.toISOString() ?? null,
          },
          now,
        });
        return toCoupon(row, undefined);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'package_coupons_code_unique')) {
        throw new ApiError('CONFLICT', 'This coupon code is taken');
      }
      throw error;
    }
  }

  /**
   * PATCH /admin/coupons/:id: the row locked, changed, and `finance.coupon_updated` with only what
   * changed, in one transaction. Nothing changed: the coupon as it is, no audit row.
   */
  async update(
    actorId: string,
    id: string,
    body: {
      isActive?: boolean | undefined;
      maxRedemptions?: number | undefined;
      expiresAt?: string | null | undefined;
    },
  ): Promise<AdminCoupon> {
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(packageCoupons)
        .where(eq(packageCoupons.id, id))
        .limit(1)
        .for('update');
      if (row === undefined) throw notFound('Coupon');
      const changes: FinanceAuditMeta<'finance.coupon_updated'>['changes'] = {};
      if (body.isActive !== undefined && body.isActive !== row.isActive) {
        changes.isActive = { from: row.isActive, to: body.isActive };
      }
      if (body.maxRedemptions !== undefined && body.maxRedemptions !== row.maxRedemptions) {
        changes.maxRedemptions = { from: row.maxRedemptions, to: body.maxRedemptions };
      }
      if (body.expiresAt !== undefined) {
        const from = row.expiresAt?.toISOString() ?? null;
        const to = body.expiresAt === null ? null : new Date(body.expiresAt).toISOString();
        if (to !== null && new Date(to).getTime() <= now.getTime()) {
          throw validationError(['body', 'expiresAt'], 'must be in the future');
        }
        if (from !== to) changes.expiresAt = { from, to };
      }
      if (Object.keys(changes).length === 0) {
        const [same] = await this.withUses(tx, [row]);
        return same as AdminCoupon;
      }
      const [updated] = await tx
        .update(packageCoupons)
        .set({
          ...(changes.isActive !== undefined ? { isActive: changes.isActive.to } : {}),
          ...(changes.maxRedemptions !== undefined
            ? { maxRedemptions: changes.maxRedemptions.to }
            : {}),
          ...(changes.expiresAt !== undefined
            ? { expiresAt: changes.expiresAt.to === null ? null : new Date(changes.expiresAt.to) }
            : {}),
          updatedAt: now,
        })
        .where(eq(packageCoupons.id, id))
        .returning();
      if (updated === undefined) throw new Error('Updated coupon vanished');
      await writeFinanceAudit(tx, {
        actorId,
        action: 'finance.coupon_updated',
        target: 'coupon',
        targetId: id,
        meta: { code: row.code, changes },
        now,
      });
      const [out] = await this.withUses(tx, [updated]);
      return out as AdminCoupon;
    });
  }
}
