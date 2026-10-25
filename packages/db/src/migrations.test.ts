import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './migrate';
import * as schema from './schema/index';

interface Journal {
  entries: { idx: number; tag: string }[];
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as Journal;
const sqlOf = (tag: string) => readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
const statements = (sql: string) =>
  sql
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s !== '');

describe('migrations', () => {
  it('starts with migration 0000_init', () => {
    expect(journal.entries[0]?.tag).toBe('0000_init');
  });

  // drizzle-kit's snapshot types are written against zod 3 and don't resolve with zod 4, so the
  // snapshots are passed through as opaque values.
  const latestSnapshot = (): { id: string } => {
    const last = journal.entries.at(-1);
    if (last === undefined) throw new Error('no migrations');
    const snapshotFile = `${String(last.idx).padStart(4, '0')}_snapshot.json`;
    return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', snapshotFile), 'utf8')) as {
      id: string;
    };
  };
  const diff = async (tables: Record<string, unknown>): Promise<string[]> => {
    const snapshot = latestSnapshot();
    const current: unknown = generateDrizzleJson(tables, snapshot.id);
    return generateMigration(snapshot, current);
  };

  it('match the schema: drizzle-kit would generate nothing new', async () => {
    expect(await diff(schema)).toEqual([]);
  });

  it('would notice a schema change (the check above is not vacuous)', async () => {
    const drifted = { ...schema, probe: pgTable('drift_probe', { id: integer('id') }) };
    expect((await diff(drifted)).join('\n')).toContain('CREATE TABLE "drift_probe"');
  });

  it('creates the ltree extension before anything else', () => {
    expect(statements(sqlOf('0000_init'))[0]).toBe('CREATE EXTENSION IF NOT EXISTS ltree;');
  });

  it('partitions activity_events by month and keeps future partitions', () => {
    const sql = sqlOf('0000_init');
    expect(sql).toMatch(
      /CREATE TABLE "activity_events" \([\s\S]*?\) PARTITION BY RANGE \("created_at"\);/,
    );
    expect(sql).toContain('PARTITION OF "public"."activity_events" DEFAULT');
    expect(sql).toContain('CREATE FUNCTION "public"."activity_events_ensure_partitions"');
    expect(statements(sql).at(-1)).toBe(
      'SELECT "public"."activity_events_ensure_partitions"(now(), 3);',
    );
  });
});
