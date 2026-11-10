import { auditLog } from '@shotx/db';
import {
  ADMIN_AUDIT_TARGET_TYPES,
  type AdminAuditAction,
  type AdminAuditMeta,
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
