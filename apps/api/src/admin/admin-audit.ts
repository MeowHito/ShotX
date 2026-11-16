import { auditLog } from '@shotx/db';
import {
  ADMIN_AUDIT_TARGET_TYPES,
  type AdminAuditAction,
  type AdminAuditMeta,
  FINANCE_AUDIT_TARGET_TYPES,
  type FinanceAuditAction,
  type FinanceAuditMeta,
} from '@shotx/shared';
import type { Queryable } from '../db/db';

/**
 * An audit_log row of an admin mutation (ADMIN_AUDIT_ACTIONS), written in the mutation's own
 * transaction with the acting admin as actor. `meta` is typed per action (AdminAuditMeta, the
 * shape ADMIN_AUDIT_META_SCHEMAS gives the audit-log viewer) and never holds a password, a hash
 * or a TOTP secret.
 */
export async function writeAdminAudit<A extends AdminAuditAction>(
  q: Queryable,
  entry: {
    actorId: string;
    action: A;
    target: keyof typeof ADMIN_AUDIT_TARGET_TYPES;
    targetId: string;
    meta: AdminAuditMeta<A>;
    now: Date;
  },
): Promise<void> {
  await q.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: ADMIN_AUDIT_TARGET_TYPES[entry.target],
    targetId: entry.targetId,
    meta: entry.meta,
    createdAt: entry.now,
  });
}

/**
 * An audit_log row of an expenses-ledger write (FINANCE_AUDIT_ACTIONS, ADR 0027), in the write's
 * own transaction with the acting admin as actor. `meta` never copies the note.
 */
export async function writeFinanceAudit<A extends FinanceAuditAction>(
  q: Queryable,
  entry: { actorId: string; action: A; targetId: string; meta: FinanceAuditMeta<A>; now: Date },
): Promise<void> {
  await q.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: FINANCE_AUDIT_TARGET_TYPES.expense,
    targetId: entry.targetId,
    meta: entry.meta,
    createdAt: entry.now,
  });
}
