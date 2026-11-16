import { Inject, Injectable } from '@nestjs/common';
import { expenses } from '@shotx/db';
import {
  addBangkokDays,
  type AdminExpense,
  bangkokDate,
  decodeExpenseCursor,
  encodeExpenseCursor,
  EXPENSE_SPENT_ON_MAX_AHEAD_DAYS,
  type ExpenseCategory,
  type ListExpensesResponse,
} from '@shotx/shared';
import { and, desc, eq, gte, isNull, lte, type SQL, sql } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import type { Db } from '../db/db';
import { notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { API_CONFIG, CLOCK, type Clock, DATABASE } from '../tokens';
import { writeFinanceAudit } from './admin-audit';

// The manual expenses ledger (ADR 0027 §2). Money is integer satang; `spent_on` is a Bangkok day.
// Each write (insert, soft delete) is in one transaction with its audit_log row; rows are never
// updated otherwise.

type ExpenseRow = typeof expenses.$inferSelect;

function toExpense(row: ExpenseRow): AdminExpense {
  return {
    id: row.id,
    spentOn: row.spentOn,
    amountSatang: row.amountSatang,
    category: row.category,
    note: row.note,
    recordedById: row.recordedById,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class ExpensesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** GET /admin/expenses: live rows, spent_on DESC, id DESC (`expenses_spent_on_idx`). */
  async list(query: {
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<ListExpensesResponse> {
    const limit = query.limit ?? this.config.adminConsole.listPageSize;
    const filters: SQL[] = [isNull(expenses.deletedAt)];
    if (query.from !== undefined) filters.push(gte(expenses.spentOn, query.from));
    if (query.to !== undefined) filters.push(lte(expenses.spentOn, query.to));
    if (query.cursor !== undefined) {
      const cursor = decodeExpenseCursor(query.cursor);
      if (cursor === null) throw validationError(['query', 'cursor'], 'Invalid cursor');
      filters.push(
        sql`(${expenses.spentOn}, ${expenses.id}) < (${cursor.spentOn}::date, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select()
      .from(expenses)
      .where(and(...filters))
      .orderBy(desc(expenses.spentOn), desc(expenses.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toExpense),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeExpenseCursor({ v: 1, spentOn: last.spentOn, id: last.id })
          : null,
    };
  }

  /**
   * POST /admin/expenses: the row and its `finance.expense_created` audit row in one transaction;
   * the acting admin records it. `spentOn` more than EXPENSE_SPENT_ON_MAX_AHEAD_DAYS after today
   * (Bangkok, by the clock): VALIDATION_FAILED. Not idempotent.
   */
  async create(
    actorId: string,
    body: {
      spentOn: string;
      amountSatang: number;
      category: ExpenseCategory;
      note?: string | undefined;
    },
  ): Promise<AdminExpense> {
    const now = this.clock.now();
    const latest = addBangkokDays(bangkokDate(now), EXPENSE_SPENT_ON_MAX_AHEAD_DAYS);
    if (body.spentOn > latest) {
      throw validationError(['body', 'spentOn'], `must not be after ${latest}`);
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(expenses)
        .values({
          spentOn: body.spentOn,
          amountSatang: body.amountSatang,
          category: body.category,
          note: body.note ?? null,
          recordedById: actorId,
          createdAt: now,
        })
        .returning();
      if (row === undefined) throw new Error('Inserted expense vanished');
      await writeFinanceAudit(tx, {
        actorId,
        action: 'finance.expense_created',
        targetId: row.id,
        meta: { spentOn: row.spentOn, amountSatang: row.amountSatang, category: row.category },
        now,
      });
      return toExpense(row);
    });
  }

  /**
   * DELETE /admin/expenses/:id: soft delete with its `finance.expense_deleted` audit row in one
   * transaction (the row locked first). Unknown: NOT_FOUND; already deleted: a no-op (no audit).
   */
  async delete(actorId: string, id: string): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(expenses)
        .where(eq(expenses.id, id))
        .limit(1)
        .for('update');
      if (row === undefined) throw notFound('Expense');
      if (row.deletedAt !== null) return;
      await tx.update(expenses).set({ deletedAt: now }).where(eq(expenses.id, id));
      await writeFinanceAudit(tx, {
        actorId,
        action: 'finance.expense_deleted',
        targetId: row.id,
        meta: { spentOn: row.spentOn, amountSatang: row.amountSatang, category: row.category },
        now,
      });
    });
  }
}
