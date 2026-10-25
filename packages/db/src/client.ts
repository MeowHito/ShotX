import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { type DatabaseConfig, pgPoolConfig } from './config';
import * as schema from './schema/index';

export type Database = NodePgDatabase<typeof schema>;

/** A connection pool built only from `config` (see pgPoolConfig). The caller ends it. */
export function createPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool(pgPoolConfig(config));
}

/** A Drizzle database over a node-postgres pool, with the full schema. */
export function createDb(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}
