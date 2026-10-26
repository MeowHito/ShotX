import { authSessions } from '@shotx/db';
import { sql } from 'drizzle-orm';
import { rows } from '../db';
import { type JobContext, mayContinue } from './context';

export interface AuthSessionsPurgeResult {
  deleted: number;
  complete: boolean;
}

/**
 * `auth.sessions.purge.daily`: deletes `auth_sessions` rows whose `expires_at` is more than
 * AUTH_SESSION_RETENTION_DAYS in the past, `batchSize` rows per DELETE, until none are left or
 * the runtime is up. Revoked rows go with their family's expiry (every row of a family shares
 * `expires_at`), so reuse detection keeps working while a family can still be presented.
 * `replaced_by_id` is ON DELETE SET NULL (migration 0006), so batches may split a family.
 * Idempotent: a re-run deletes what is left.
 */
export async function runAuthSessionsPurge(
  ctx: JobContext,
  options: { retentionDays: number; batchSize: number },
): Promise<AuthSessionsPurgeResult> {
  let deleted = 0;
  let complete = true;
  for (;;) {
    if (!mayContinue(ctx)) {
      complete = false;
      break;
    }
    const batch = await rows<{ id: string }>(
      ctx.db,
      sql`DELETE FROM ${authSessions}
        WHERE ${authSessions.id} IN (
          SELECT ${authSessions.id} FROM ${authSessions}
          WHERE ${authSessions.expiresAt} < now() - make_interval(days => ${options.retentionDays})
          ORDER BY ${authSessions.expiresAt}
          LIMIT ${options.batchSize}
        )
        RETURNING ${authSessions.id} AS "id"`,
    );
    deleted += batch.length;
    if (batch.length < options.batchSize) break;
  }
  return { deleted, complete };
}
