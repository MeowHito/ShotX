import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` uses this file, and it needs no database. Migrations are applied by
// src/migrate.ts with the connection from loadDatabaseConfig, never by drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
