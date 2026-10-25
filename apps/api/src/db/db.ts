import type { Database } from '@shotx/db';
import type { SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * The database the API talks to: node-postgres in production, PGlite or a throwaway PostgreSQL in
 * tests. Both are Drizzle PgDatabases over the full schema.
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

/** The full Drizzle schema of @shotx/db (the package exports the tables, not a namespace). */
export type Schema = Database extends PgDatabase<PgQueryResultHKT, infer S> ? S : never;

/** A transaction (or savepoint) handle. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything a query can run on. */
export type Queryable = Db | Tx;

/** Rows of a raw query. Both drivers return `{ rows }`, which the shared type can't express. */
export async function rows<T extends Record<string, unknown>>(
  db: Queryable,
  query: SQL,
): Promise<T[]> {
  const result: unknown = await db.execute(query);
  return (result as { rows: T[] }).rows;
}

export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
} as const;

export interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
}

/** The PostgreSQL error inside a driver or Drizzle error (Drizzle wraps it in `cause`). */
export function pgErrorInfo(error: unknown): PgErrorInfo | null {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e instanceof Error; depth++) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
    }
    e = e.cause;
  }
  return null;
}

/** True for a unique violation, optionally of one named constraint or index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(error);
  return (
    info?.code === SQLSTATE.UNIQUE_VIOLATION &&
    (constraint === undefined || info.constraint === undefined || info.constraint === constraint)
  );
}
