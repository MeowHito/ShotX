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
  it('starts with 0000_init, 0001_share_targets_zip_jobs and 0002_drive', () => {
    expect(journal.entries.slice(0, 3).map((e) => [e.idx, e.tag])).toEqual([
      [0, '0000_init'],
      [1, '0001_share_targets_zip_jobs'],
      [2, '0002_drive'],
    ]);
  });

  it('0002 backfills files before adding the checks and unique indexes that need it', () => {
    const list = statements(sqlOf('0002_drive'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    expect(at('SET "verified_at" = "created_at"')).toBeGreaterThan(at('ADD COLUMN "verified_at"'));
    expect(at('SET "upload_expires_at"')).toBeGreaterThan(at('ADD COLUMN "upload_expires_at"'));
    expect(at('SET "upload_id" = NULL')).toBeLessThan(at('"files_upload_id_while_uploading"'));
    expect(at('SET "upload_expires_at"')).toBeLessThan(at('"files_upload_id_while_uploading"'));
    expect(at('DROP CONSTRAINT "zip_job_entries_name_unique"')).toBeLessThan(
      at('"zip_job_entries_name_folded_unique"'),
    );
    for (const name of ['folders_live_name_unique', 'files_live_name_unique']) {
      expect(list[at(`"${name}"`)]).toMatch(/lower\("name" COLLATE "C"\)/);
    }
  });

  it('0003 is sharing_face_search and backfills before the checks and indexes that need it', () => {
    expect(journal.entries[3]?.tag).toBe('0003_sharing_face_search');
    const list = statements(sqlOf('0003_sharing_face_search'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    expect(at('SET "upload_part_bytes"')).toBeGreaterThan(at('ADD COLUMN "upload_part_bytes"'));
    expect(at('SET "upload_part_bytes"')).toBeLessThan(at('"files_upload_part_bytes_valid"'));
    expect(at('SET "face_index_enabled" = false')).toBeGreaterThan(
      at('ADD COLUMN "face_index_informed_at"'),
    );
    expect(at('SET "face_index_enabled" = false')).toBeLessThan(
      at('"folders_face_index_needs_confirmation"'),
    );
    expect(at('SET "anon_id" = NULL')).toBeGreaterThan(
      at('DROP CONSTRAINT "consents_viewer_or_anon"'),
    );
    expect(at('SET "anon_id" = NULL')).toBeLessThan(at('ADD CONSTRAINT "consents_viewer_or_anon"'));
    expect(at('AS "c" SET "withdrawn_at"')).toBeLessThan(at('"consents_current_anon_unique"'));
    // A CHECK added to the partitioned table must not qualify columns with the table name.
    expect(list[at('"activity_events_source_share"')]).not.toContain('"activity_events"."');
  });

  it('never edits a committed migration: each snapshot chains to the previous one', () => {
    const snapshots = journal.entries.map(
      (e) =>
        JSON.parse(
          readFileSync(
            join(MIGRATIONS_FOLDER, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`),
            'utf8',
          ),
        ) as { id: string; prevId: string },
    );
    snapshots.forEach((snapshot, i) => {
      expect(snapshot.prevId).toBe(
        i === 0 ? '00000000-0000-0000-0000-000000000000' : snapshots[i - 1]?.id,
      );
    });
  });

  it('backfills share targets before dropping target_id, and adds the owner key first', () => {
    const list = statements(sqlOf('0001_share_targets_zip_jobs'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    expect(at('SET "target_file_id" = "target_id"')).toBeGreaterThan(
      at('ADD COLUMN "target_file_id"'),
    );
    expect(at('SET "target_folder_id" = "target_id"')).toBeGreaterThan(
      at('ADD COLUMN "target_folder_id"'),
    );
    expect(at('DROP COLUMN "target_id"')).toBeGreaterThan(at('SET "target_folder_id"'));
    expect(at('"zip_jobs_share_same_owner_fk"')).toBeGreaterThan(at('"shares_id_owner_unique"'));
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
