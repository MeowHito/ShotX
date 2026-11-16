import { Inject, Injectable } from '@nestjs/common';
import { auditLog, users } from '@shotx/db';
import {
  bangkokRangeInstants,
  decodeAuditLogCursor,
  encodeAuditLogCursor,
  isAuditActionPrefix,
  type ListAuditLogResponse,
} from '@shotx/shared';
import { and, desc, eq, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ApiConfig } from '../config';
import type { Db } from '../db/db';
import { validationError } from '../http/zod';
import { API_CONFIG, DATABASE } from '../tokens';
import { escapeLike } from './finance-math';

// GET /admin/audit-log (ADR 0027 §1): the audit log, newest first, read-only (not audited).

const actor = alias(users, 'actor');
const target = alias(users, 'target');

/** A uuid in text form; only those target ids are cast to look up a user target. */
const UUID_TEXT = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Keyset pages over (created_at DESC, id DESC): `audit_log_created_idx`, or with a filter
   * `audit_log_action_idx` (each `action` value exact, or `LIKE 'prefix%'` with `_`/`%`/`\`
   * escaped, text_pattern_ops; several values OR-ed),
   * `audit_log_actor_created_idx` or `audit_log_target_id_idx`. The actor's email comes from a
   * join on users; the target's email only when `target_type` is `user` (target ids are text, so
   * the join casts only ids that look like uuids).
   */
  async list(query: {
    action?: readonly string[] | undefined;
    actorId?: string | undefined;
    targetId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<ListAuditLogResponse> {
    const limit = query.limit ?? this.config.adminConsole.listPageSize;
    const filters: SQL[] = [];
    if (query.action !== undefined && query.action.length > 0) {
      // Several values are OR-ed; each is exact or a LIKE prefix with wildcards escaped.
      const matches = query.action.map((action) =>
        isAuditActionPrefix(action)
          ? sql`${auditLog.action} LIKE ${`${escapeLike(action)}%`}`
          : eq(auditLog.action, action),
      );
      const match = matches.length === 1 ? matches[0] : or(...matches);
      if (match !== undefined) filters.push(match);
    }
    if (query.actorId !== undefined) filters.push(eq(auditLog.actorId, query.actorId));
    if (query.targetId !== undefined) filters.push(eq(auditLog.targetId, query.targetId));
    if (query.from !== undefined) {
      const { start } = bangkokRangeInstants(query.from, query.from);
      filters.push(sql`${auditLog.createdAt} >= ${start.toISOString()}::timestamptz`);
    }
    if (query.to !== undefined) {
      const { end } = bangkokRangeInstants(query.to, query.to);
      filters.push(sql`${auditLog.createdAt} < ${end.toISOString()}::timestamptz`);
    }
    if (query.cursor !== undefined) {
      const cursor = decodeAuditLogCursor(query.cursor);
      if (cursor === null) throw validationError(['query', 'cursor'], 'Invalid cursor');
      filters.push(
        sql`(${auditLog.createdAt}, ${auditLog.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const page = await this.db
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        createdAtText: sql<string>`${auditLog.createdAt}::text`,
        action: auditLog.action,
        actorId: auditLog.actorId,
        actorEmail: actor.email,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        targetEmail: target.email,
        meta: auditLog.meta,
      })
      .from(auditLog)
      .leftJoin(actor, eq(actor.id, auditLog.actorId))
      .leftJoin(
        target,
        and(
          eq(auditLog.targetType, 'user'),
          sql`${target.id} = (CASE WHEN ${auditLog.targetId} ~ ${UUID_TEXT} THEN ${auditLog.targetId}::uuid END)`,
        ),
      )
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1);
    const items = page.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        actorId: row.actorId,
        actorEmail: row.actorId === null ? null : row.actorEmail,
        targetType: row.targetType,
        targetId: row.targetId,
        targetEmail: row.targetEmail,
        meta: row.meta,
      })),
      nextCursor:
        page.length > limit && last !== undefined
          ? encodeAuditLogCursor({ v: 1, createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }
}
