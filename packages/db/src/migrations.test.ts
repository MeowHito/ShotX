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

  it('0004 is phase3_fixes_billing and backfills before the checks that need them', () => {
    expect(journal.entries[4]?.tag).toBe('0004_phase3_fixes_billing');
    const list = statements(sqlOf('0004_phase3_fixes_billing'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    expect(at('ADD COLUMN "photographer_id" uuid;')).toBeGreaterThan(-1);
    expect(at('UPDATE "payments" AS "p" SET "photographer_id"')).toBeGreaterThan(
      at('ADD COLUMN "photographer_id"'),
    );
    expect(at('ALTER COLUMN "photographer_id" SET NOT NULL')).toBeGreaterThan(
      at('UPDATE "payments" AS "p" SET "photographer_id"'),
    );
    expect(at('SET "period_start" = LEAST')).toBeLessThan(at('"subscriptions_period_order"'));
    expect(at(`SET "billing" = 'prepaid'`)).toBeLessThan(
      at('"subscriptions_auto_renew_has_method"'),
    );
    expect(at('SET "refunded_at"')).toBeLessThan(at('"payments_refunded_has_refunded_at"'));
    expect(at('DROP INDEX "consents_current_anon_unique"')).toBeLessThan(
      at('CREATE UNIQUE INDEX "consents_current_anon_unique"'),
    );
    expect(list[at('CREATE UNIQUE INDEX "consents_current_anon_unique"')]).toContain('"purpose"');
  });

  it('0005 is shotx_auth: renames before use, the (id, auth_pool) key before its foreign keys', () => {
    expect(journal.entries[5]?.tag).toBe('0005_shotx_auth');
    const list = statements(sqlOf('0005_shotx_auth'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    const renames = [
      'RENAME COLUMN "cognito_pool" TO "auth_pool"',
      'RENAME COLUMN "cognito_sub" TO "auth_subject"',
      'RENAME CONSTRAINT "users_cognito_identity_unique" TO "users_auth_identity_unique"',
      'RENAME CONSTRAINT "users_cognito_sub_not_empty" TO "users_auth_subject_not_empty"',
    ];
    for (const rename of renames) expect(at(rename), rename).toBeGreaterThan(-1);
    // Renames only: no column of users is dropped or re-added, so no data moves.
    expect(list.some((s) => /DROP COLUMN|ADD COLUMN "auth_/.test(s))).toBe(false);
    const firstUse = Math.min(at('"users_id_auth_pool_unique"'), at('"users_admin_email_unique"'));
    for (const rename of renames.slice(0, 2)) expect(at(rename)).toBeLessThan(firstUse);
    expect(at('ADD CONSTRAINT "users_id_auth_pool_unique"')).toBeLessThan(
      at('"auth_sessions_user_pool_fk"'),
    );
    expect(at('ADD CONSTRAINT "users_id_auth_pool_unique"')).toBeLessThan(
      at('"admin_credentials_admin_user_fk"'),
    );
    expect(at('"users_admin_iff_admins_pool"')).toBe(-1);
  });

  it('0006 is sweeps_outbox: additive columns, partial indexes, set-null successor key', () => {
    expect(journal.entries[6]?.tag).toBe('0006_sweeps_outbox');
    const list = statements(sqlOf('0006_sweeps_outbox'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    // Nothing is dropped except the successor foreign key, which is re-added with SET NULL.
    expect(list.filter((s) => /\bDROP\b/.test(s))).toEqual([
      'ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_replaced_by_id_auth_sessions_id_fk";',
    ]);
    expect(list[at('ADD CONSTRAINT "auth_sessions_replaced_by_id_auth_sessions_id_fk"')]).toContain(
      'ON DELETE set null',
    );
    for (const column of ['media_requeues', 'faces_requeues']) {
      expect(list[at(`ADD COLUMN "${column}"`)], column).toContain('DEFAULT 0 NOT NULL');
    }
    for (const column of ['media_queued_at', 'faces_queued_at', 'face_index_queued_at']) {
      expect(list[at(`ADD COLUMN "${column}"`)], column).not.toContain('NOT NULL');
    }
    for (const name of [
      'files_uploading_created_idx',
      'files_processing_idx',
      'files_faces_pending_idx',
      'folders_face_index_pending_idx',
    ]) {
      expect(list[at(`CREATE INDEX "${name}"`)], name).toContain(' WHERE ');
    }
    expect(at('"files_requeues_nonnegative"')).toBeGreaterThan(at('ADD COLUMN "faces_requeues"'));
  });

  it('0007 is faces_coverage_scan: one partial index, nothing else', () => {
    expect(journal.entries[7]?.tag).toBe('0007_faces_coverage_scan');
    const list = statements(sqlOf('0007_faces_coverage_scan'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(
      /^CREATE INDEX "files_unindexed_ready_idx" ON "files" .*\("folder_id","id"\) WHERE /,
    );
    for (const term of [
      '"status" = \'ready\'',
      '"face_count" IS NULL',
      '"faces_queued_at" IS NULL',
      '"deleted_at" IS NULL',
    ]) {
      expect(list[0], term).toContain(term);
    }
  });

  it('0008 is studio_copy_search_owner_zip: pg_trgm first, then the copy, search and owner zip changes', () => {
    expect(journal.entries[8]?.tag).toBe('0008_studio_copy_search_owner_zip');
    const list = statements(sqlOf('0008_studio_copy_search_owner_zip'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    expect(list[0]).toBe('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    for (const name of ['files_name_trgm_idx', 'folders_name_trgm_idx']) {
      expect(list[at(`CREATE INDEX "${name}"`)], name).toMatch(
        /USING gin \(lower\("name" COLLATE "C"\) gin_trgm_ops\)/,
      );
    }
    expect(at('ALTER COLUMN "share_id" DROP NOT NULL')).toBeGreaterThan(-1);
    // The relaxed entry check is added after the old one is dropped.
    expect(at('DROP CONSTRAINT "zip_job_entries_name_valid"')).toBeLessThan(
      at('ADD CONSTRAINT "zip_job_entries_name_valid"'),
    );
    expect(list[at('ADD CONSTRAINT "zip_job_entries_name_valid"')]).toContain('(^|/)\\.\\.?(/|$)');
  });

  it('0009 is faces_withheld: the column, then the coverage index rebuilt to exclude it', () => {
    expect(journal.entries[9]?.tag).toBe('0009_faces_withheld');
    const list = statements(sqlOf('0009_faces_withheld'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    expect(list[at('ADD COLUMN "faces_withheld_at"')]).not.toContain('NOT NULL');
    expect(at('DROP INDEX "files_unindexed_ready_idx"')).toBeLessThan(
      at('CREATE INDEX "files_unindexed_ready_idx"'),
    );
    expect(list[at('CREATE INDEX "files_unindexed_ready_idx"')]).toContain(
      '"files"."faces_withheld_at" IS NULL',
    );
  });

  it('0011 is admin_accounts: additive, the enum before its column, keys before their users', () => {
    expect(journal.entries[11]?.tag).toBe('0011_admin_accounts');
    const list = statements(sqlOf('0011_admin_accounts'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    // Nothing is dropped or renamed; only the TOTP columns are relaxed.
    expect(list.filter((s) => /\bDROP\b/.test(s))).toEqual([
      'ALTER TABLE "admin_credentials" ALTER COLUMN "totp_secret_encrypted" DROP NOT NULL;',
      'ALTER TABLE "admin_credentials" ALTER COLUMN "totp_secret_nonce" DROP NOT NULL;',
    ]);
    expect(list.some((s) => /RENAME/.test(s))).toBe(false);
    expect(at('CREATE TYPE "public"."account_status"')).toBeLessThan(at('ADD COLUMN "status"'));
    expect(list[at('ADD COLUMN "status"')]).toContain(`DEFAULT 'active' NOT NULL`);
    expect(list[at('ADD COLUMN "must_change_password"')]).toContain('DEFAULT false NOT NULL');
    for (const column of ['disabled_at', 'created_by_id', 'last_sign_in_at']) {
      expect(list[at(`ADD COLUMN "${column}"`)], column).not.toContain('NOT NULL');
    }
    expect(at('ADD COLUMN "disabled_at"')).toBeLessThan(at('"users_disabled_at_iff_disabled"'));
    expect(list[at('"users_password_account_email_unique"')]).toMatch(
      /lower\("email" COLLATE "C"\)\) WHERE .*'admin:%'.*'password:%'/,
    );
  });

  it('0012 is event_gallery_admin_mfa: additive, backfills before the constraints that need them', () => {
    expect(journal.entries[12]?.tag).toBe('0012_event_gallery_admin_mfa');
    const list = statements(sqlOf('0012_event_gallery_admin_mfa'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    // Only the confirmation CHECK is dropped (ADR 0011 decision 1); nothing is renamed.
    expect(list.filter((s) => /\bDROP\b/.test(s))).toEqual([
      'ALTER TABLE "folders" DROP CONSTRAINT "folders_face_index_needs_confirmation";',
    ]);
    expect(list.some((s) => /RENAME/.test(s))).toBe(false);
    // New columns: nullable, or with a constant default (no table rewrite, old api inserts work).
    for (const column of ['slug', 'cover_file_id', 'amr']) {
      expect(list[at(`ADD COLUMN "${column}"`)], column).not.toContain('NOT NULL');
    }
    expect(list[at('ADD COLUMN "locale"')]).toContain(`DEFAULT 'th' NOT NULL`);
    expect(at('CREATE TYPE "public"."ui_locale"')).toBeLessThan(at('ADD COLUMN "locale"'));
    // Folders are switched on before the new CHECK, with the expiry the CHECK needs.
    const enable = at('UPDATE "folders" SET');
    expect(enable).toBeGreaterThan(at('DROP CONSTRAINT "folders_face_index_needs_confirmation"'));
    expect(enable).toBeLessThan(at('ADD CONSTRAINT "folders_face_index_has_expiry"'));
    expect(list[enable]).toContain('"face_index_queued_at"');
    // Slugs are backfilled after the column and before the unique and format constraints.
    const backfill = at('UPDATE "shares" AS "s" SET "slug"');
    expect(backfill).toBeGreaterThan(at('ADD COLUMN "slug"'));
    expect(backfill).toBeLessThan(at('"shares_slug_unique"'));
    expect(backfill).toBeLessThan(at('"shares_slug_valid"'));
    // The cover key clears only cover_file_id (owner_id is NOT NULL).
    expect(list[at('"folders_cover_file_same_owner_fk"')]).toContain(
      'ON DELETE SET NULL ("cover_file_id")',
    );
  });

  it('0013 is share_designs: additive, the design key clears only design_id', () => {
    expect(journal.entries[13]?.tag).toBe('0013_share_designs');
    const list = statements(sqlOf('0013_share_designs'));
    const at = (fragment: string) => list.findIndex((s) => s.includes(fragment));
    expect(list.some((s) => /\b(DROP|RENAME)\b/.test(s))).toBe(false);
    // The previous api keeps inserting shares: the new column is nullable without a default.
    expect(list[at('ADD COLUMN "design_id"')]).toBe(
      'ALTER TABLE "shares" ADD COLUMN "design_id" uuid;',
    );
    expect(at('CREATE TABLE "share_designs"')).toBeLessThan(at('"shares_design_same_owner_fk"'));
    expect(list[at('"shares_design_same_owner_fk"')]).toContain('ON DELETE SET NULL ("design_id")');
    expect(list[at('"share_designs_one_default_per_owner"')]).toMatch(
      /^CREATE UNIQUE INDEX .* \("owner_id"\) WHERE "share_designs"\."is_default";$/,
    );
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
