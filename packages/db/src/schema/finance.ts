import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import { authPool, expenseCategory } from './enums';

// Admin finance (ADR 0027, migration 0017). Income is read from package_orders and cash_payments;
// this is the manual expenses ledger. Money is integer satang.

/**
 * Expenses an admin records (POST /admin/expenses). Each write (insert, soft delete) is in one
 * transaction with its `finance.expense_created` / `finance.expense_deleted` audit_log row.
 *
 * - `spent_on`: the Bangkok calendar day the money was spent, at most a day after the Bangkok day
 *   the row was recorded (`expenses_spent_on_not_future`, EXPENSE_SPENT_ON_MAX_AHEAD_DAYS).
 * - `amount_satang` > 0; `note` 1-500 characters or null (EXPENSE_NOTE_MAX_LENGTH).
 * - (recorded_by_id, recorded_by_pool) references users (id, auth_pool) with the pool fixed to
 *   `admins`, so the recorder is always an admin (as cash_payments).
 * - `deleted_at`: soft delete (DELETE /admin/expenses/:id); deleted rows are kept, never listed or
 *   summed. Nothing else updates a row.
 */
export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    spentOn: date('spent_on', { mode: 'string' }).notNull(),
    amountSatang: integer('amount_satang').notNull(),
    category: expenseCategory('category').notNull(),
    note: text('note'),
    recordedById: uuid('recorded_by_id').notNull(),
    recordedByPool: authPool('recorded_by_pool').notNull().default('admins'),
    createdAt: createdAt(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    foreignKey({
      name: 'expenses_recorded_by_admin_fk',
      columns: [t.recordedById, t.recordedByPool],
      foreignColumns: [users.id, users.authPool],
    }),
    // GET /admin/expenses (keyset) and the finance sums by day.
    index('expenses_spent_on_idx')
      .on(t.spentOn.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    check('expenses_recorded_by_pool', sql`${t.recordedByPool} = 'admins'`),
    check('expenses_amount_positive', sql`${t.amountSatang} > 0`),
    check(
      'expenses_note_length',
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`,
    ),
    check(
      'expenses_spent_on_not_future',
      sql`${t.spentOn} <= (${t.createdAt} AT TIME ZONE 'Asia/Bangkok')::date + 1`,
    ),
    check(
      'expenses_deleted_after_created',
      sql`${t.deletedAt} IS NULL OR ${t.deletedAt} >= ${t.createdAt}`,
    ),
  ],
);
