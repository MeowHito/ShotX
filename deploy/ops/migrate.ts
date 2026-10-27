import { createDb, createPool, loadDatabaseConfig, migrateDatabase, seedPlans } from '@shotx/db';
import type { Env } from '@shotx/shared';

// The one-off `migrate` compose service: migrations, the plan seed (never overwrites), and the
// monitor role's column grants. Runs before api and worker start (depends_on).

/** The read-only database role of the monitor (created by deploy/postgres/01-init.sh). */
export const MONITOR_DB_ROLE = 'shotx_monitor';

/**
 * Exactly the columns the monitor reads: counts and ids only, never names, emails or keys.
 * Re-applied after every migration so a new column is never readable by accident.
 */
export const MONITOR_GRANTS: Record<string, readonly string[]> = {
  files: ['id', 'status', 'deleted_at', 'media_queued_at', 'media_requeues', 'created_at'],
  face_deletions: ['id', 'share_id', 'created_at', 'completed_at'],
};

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a plain identifier: ${name}`);
  return `"${name}"`;
};

/** REVOKE everything, then GRANT SELECT on the listed columns only. */
export function monitorGrantStatements(role = MONITOR_DB_ROLE): string[] {
  const r = ident(role);
  return [
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`,
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    ...Object.entries(MONITOR_GRANTS).map(
      ([table, columns]) =>
        `GRANT SELECT (${columns.map(ident).join(', ')}) ON ${ident(table)} TO ${r}`,
    ),
  ];
}

export async function runMigrate(env: Env, log: (line: string) => void): Promise<void> {
  const config = loadDatabaseConfig(env);
  await migrateDatabase(config);
  log(`migrations applied to ${config.database} on ${config.host}`);
  const pool = createPool(config);
  try {
    const inserted = await seedPlans(createDb(pool));
    log(inserted.length > 0 ? `seeded plans: ${inserted.join(', ')}` : 'plans already seeded');
    const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [MONITOR_DB_ROLE]);
    if (role.rowCount === 0) {
      log(
        `role ${MONITOR_DB_ROLE} not found: monitor database checks will fail (see deploy/README.md)`,
      );
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const sql of monitorGrantStatements()) await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    log(`column grants applied to ${MONITOR_DB_ROLE}`);
  } finally {
    await pool.end();
  }
}
