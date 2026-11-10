import { Inject, Injectable } from '@nestjs/common';
import { cashPayments, users } from '@shotx/db';
import {
  type AdminCashPayment,
  CASH_PAYMENT_PAID_AT_MAX_AHEAD_SECONDS,
  decodeCashPaymentCursor,
  encodeCashPaymentCursor,
  type ListCashPaymentsResponse,
} from '@shotx/shared';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import type { Db, Queryable } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { sha256Hex } from '../http/client';
import { validationError } from '../http/zod';
import { API_CONFIG, CLOCK, type Clock, DATABASE } from '../tokens';
import { writeAdminAudit } from './admin-audit';

// The optional cash-payment ledger (ADR 0010): an admin records cash a photographer paid the
// owner. Bookkeeping only: no VAT split, no subscription, recording one doesn't enable an account.
// Rows are never updated or deleted. Money is integer satang.

export interface CashPaymentInput {
  photographerId: string;
  amountSatang: number;
  paidAt: string;
  note?: string | undefined;
}

/**
 * `request_sha256`: hex SHA-256 of the canonical request (fixed key order, `paidAt` as the
 * instant in UTC ISO form, an absent note as null), so equal requests hash equally however the
 * client formats them.
 */
export function cashPaymentRequestSha256(input: CashPaymentInput): string {
  return sha256Hex(
    JSON.stringify([
      input.photographerId.toLowerCase(),
      input.amountSatang,
      new Date(input.paidAt).toISOString(),
      input.note ?? null,
    ]),
  );
}

type CashPaymentRow = typeof cashPayments.$inferSelect;

function toCashPayment(row: CashPaymentRow): AdminCashPayment {
  return {
    id: row.id,
    photographerId: row.photographerId,
    amountSatang: row.amountSatang,
    paidAt: row.paidAt.toISOString(),
    note: row.note,
    recordedById: row.recordedById,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class CashPaymentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** GET /admin/cash-payments: paid_at DESC, id DESC, optionally of one photographer. */
  async list(query: {
    photographerId?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<ListCashPaymentsResponse> {
    const limit = query.limit ?? this.config.adminConsole.listPageSize;
    const filters: SQL[] = [];
    if (query.photographerId !== undefined) {
      filters.push(eq(cashPayments.photographerId, query.photographerId));
    }
    if (query.cursor !== undefined) {
      const cursor = decodeCashPaymentCursor(query.cursor);
      if (cursor === null) throw validationError(['query', 'cursor'], 'Invalid cursor');
      filters.push(
        sql`(${cashPayments.paidAt}, ${cashPayments.id}) < (${cursor.paidAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({ row: cashPayments, paidAtText: sql<string>`${cashPayments.paidAt}::text` })
      .from(cashPayments)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(cashPayments.paidAt), desc(cashPayments.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => toCashPayment(r.row)),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCashPaymentCursor({ v: 1, paidAt: last.paidAtText, id: last.row.id })
          : null,
    };
  }

  private async byKey(
    q: Queryable,
    actorId: string,
    idempotencyKey: string,
  ): Promise<CashPaymentRow | null> {
    const [row] = await q
      .select()
      .from(cashPayments)
      .where(
        and(
          eq(cashPayments.recordedById, actorId),
          eq(cashPayments.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The first row of this key if it was for the same request, else IDEMPOTENCY_KEY_REUSED. */
  private replay(row: CashPaymentRow, requestSha256: string): AdminCashPayment {
    if (row.requestSha256 !== requestSha256) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used for another request',
      );
    }
    return toCashPayment(row);
  }

  /**
   * POST /admin/cash-payments: idempotent per recording admin and Idempotency-Key (the same
   * request answers the first row; another one IDEMPOTENCY_KEY_REUSED). The row and its
   * `admin.cash_payment.created` audit row are written in one transaction. Not a photographer:
   * NOT_FOUND; `paidAt` more than a day ahead: VALIDATION_FAILED.
   */
  async create(
    actorId: string,
    idempotencyKey: string,
    body: CashPaymentInput,
  ): Promise<AdminCashPayment> {
    const requestSha256 = cashPaymentRequestSha256(body);
    const existing = await this.byKey(this.db, actorId, idempotencyKey);
    if (existing !== null) return this.replay(existing, requestSha256);

    const now = this.clock.now();
    const paidAt = new Date(body.paidAt);
    if (paidAt.getTime() > now.getTime() + CASH_PAYMENT_PAID_AT_MAX_AHEAD_SECONDS * 1000) {
      throw validationError(['body', 'paidAt'], 'must not be more than a day in the future');
    }
    const inserted = await this.db.transaction(async (tx) => {
      const [photographer] = await tx
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.id, body.photographerId), eq(users.authPool, 'users')))
        .limit(1);
      if (photographer?.role !== 'photographer') throw notFound('Photographer');
      // A concurrent request with the same key waits here on the unique index, then inserts
      // nothing; it answers from the committed row below.
      const [row] = await tx
        .insert(cashPayments)
        .values({
          photographerId: body.photographerId,
          amountSatang: body.amountSatang,
          paidAt,
          note: body.note ?? null,
          recordedById: actorId,
          idempotencyKey,
          requestSha256,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [cashPayments.recordedById, cashPayments.idempotencyKey] })
        .returning();
      if (row === undefined) return null;
      await writeAdminAudit(tx, {
        actorId,
        action: 'admin.cash_payment.created',
        target: 'cashPayment',
        targetId: row.id,
        meta: {
          photographerId: row.photographerId,
          amountSatang: row.amountSatang,
          paidAt: row.paidAt.toISOString(),
        },
        now,
      });
      return row;
    });
    if (inserted !== null) return toCashPayment(inserted);
    const raced = await this.byKey(this.db, actorId, idempotencyKey);
    if (raced === null) throw new Error('Idempotent cash payment vanished');
    return this.replay(raced, requestSha256);
  }
}
