import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

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
