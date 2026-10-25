import { type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL `ltree` (extension created by migration 0000). Values are dot-separated labels; see
 * src/ltree.ts for how folder paths are built.
 */
export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'ltree';
  },
});

/** uuid primary key. uuidv7() (PostgreSQL 18) is time-ordered, which keeps btree inserts local. */
export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => timestamptz('created_at').notNull().defaultNow();

/** The nil uuid. Unique indexes use it for the drive root, where parent_id/folder_id is null. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The key sibling names collide on: `lower(name COLLATE "C")`, which lowercases ASCII A-Z only,
 * on every PostgreSQL whatever its ctype. Same as `driveNameKey` in @shotx/shared. Use it in
 * queries too (ORDER BY, keyset comparisons, conflict lookups) so they match the indexes.
 */
export function driveNameKeySql(name: AnyPgColumn | SQL): SQL {
  return sql`lower(${name} COLLATE "C")`;
}

/** `coalesce(column, nil uuid)`: the parent key of a folder or file, with the root as nil. */
export function parentKeySql(column: AnyPgColumn): SQL {
  return sql`coalesce(${column}, ${sql.raw(`'${NIL_UUID}'::uuid`)})`;
}
