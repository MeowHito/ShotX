import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import * as dbModule from '@shotx/db';
import {
  createDb,
  createPool,
  loadDatabaseConfig,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  pgPoolConfig,
} from '@shotx/db';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import type { Db } from '../db/db';

export interface TestDatabase {
  name: string;
  db: Db;
  close(): Promise<void>;
}

/** PostgreSQL 18 in process (WASM) with ltree, migrated. One connection: no real concurrency. */
export async function openPglite(): Promise<TestDatabase> {
  const client = await PGlite.create({ extensions: { ltree } });
  const db = drizzle({ client, schema: dbModule });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { name: 'PGlite', db: db as unknown as Db, close: () => client.close() };
}

/**
 * A fresh database on the server at TEST_DATABASE_URL (CI's Postgres 18 service, or a throwaway
 * container), created from template0, migrated, and dropped on close. Needs CREATEDB.
 */
export async function openServer(url: string): Promise<TestDatabase> {
  const admin = loadDatabaseConfig({ DATABASE_URL: url });
  const name = `shotx_api_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const adminClient = new pg.Client(pgPoolConfig(admin));
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`);
  const config = { ...admin, database: name, poolMax: 8 };
  const pool = createPool(config);
  // DROP ... WITH (FORCE) may terminate sockets pool.end() is still closing.
  pool.on('error', () => undefined);
  const close = async () => {
    await pool.end();
    await adminClient.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await adminClient.end();
  };
  try {
    await migrateDatabase(config);
  } catch (error) {
    await close();
    throw error;
  }
  return { name: 'TEST_DATABASE_URL', db: createDb(pool) as unknown as Db, close };
}

const serverUrl = process.env.TEST_DATABASE_URL ?? '';

/** The backends DB tests run on: PGlite always, a real server when TEST_DATABASE_URL is set. */
export const DATABASE_BACKENDS = [
  { name: 'PGlite', open: openPglite, enabled: true },
  { name: 'TEST_DATABASE_URL', open: () => openServer(serverUrl), enabled: serverUrl !== '' },
] as const;
