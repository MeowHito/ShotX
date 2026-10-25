import {
  ACTIVITY_TYPES,
  AUTH_POOLS,
  BILLING_MODES,
  DOWNLOAD_SIZES,
  FACE_FEEDBACK_VERDICTS,
  FILE_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SHARE_MODES,
  SHARE_TARGET_TYPES,
  SUBSCRIPTION_STATUSES,
  USER_ROLES,
} from '@shotx/shared';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index';

const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);
const config = (name: string) => {
  const table = tables.find((t) => getTableName(t) === name);
  if (table === undefined) throw new Error(`no table ${name}`);
  return getTableConfig(table);
};
const column = (table: string, name: string) => {
  const found = config(table).columns.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no column ${table}.${name}`);
  return found;
};

describe('schema', () => {
  it('has every table in the data model', () => {
    expect(tables.map((t) => getTableName(t)).sort()).toEqual(
      [
        'users',
        'plans',
        'subscriptions',
        'payments',
        'storage_usage',
        'folders',
        'files',
        'faces',
        'shares',
        'consents',
        'face_feedback',
        'activity_events',
        'daily_stats',
        'audit_log',
      ].sort(),
    );
  });

  it('has the data-model columns of every table', () => {
    const expected: Record<string, string[]> = {
      users: ['id', 'email', 'name', 'role', 'cognito_sub', 'created_at'],
      plans: [
        'id',
        'code',
        'name',
        'quota_bytes',
        'price_month_satang',
        'price_year_satang',
        'is_active',
      ],
      subscriptions: [
        'id',
        'photographer_id',
        'plan_id',
        'status',
        'billing',
        'period_end',
        'cancel_at_period_end',
      ],
      payments: [
        'id',
        'subscription_id',
        'amount_satang',
        'vat_satang',
        'method',
        'gateway',
        'gateway_ref',
        'status',
        'paid_at',
      ],
      storage_usage: ['photographer_id', 'used_bytes', 'reserved_bytes'],
      folders: [
        'id',
        'owner_id',
        'parent_id',
        'name',
        'path',
        'face_index_enabled',
        'face_index_expires_at',
        'deleted_at',
      ],
      files: [
        'id',
        'owner_id',
        'folder_id',
        'name',
        'mime',
        'size_bytes',
        'sha256',
        's3_key',
        'thumb_key',
        'preview_key',
        'web_key',
        'width',
        'height',
        'taken_at',
        'status',
        'face_count',
        'deleted_at',
      ],
      faces: ['id', 'file_id', 'owner_id', 'rekognition_face_id', 'bbox', 'confidence'],
      shares: [
        'id',
        'owner_id',
        'target_type',
        'target_id',
        'token',
        'mode',
        'allow_download',
        'download_size',
        'require_login',
        'password_hash',
        'expires_at',
        'is_active',
        'created_at',
      ],
      consents: [
        'id',
        'share_id',
        'viewer_id',
        'anon_id',
        'policy_version',
        'ip_hash',
        'accepted_at',
      ],
      face_feedback: ['id', 'share_id', 'file_id', 'similarity', 'verdict', 'created_at'],
      activity_events: [
        'id',
        'type',
        'share_id',
        'file_id',
        'photographer_id',
        'viewer_id',
        'anon_id',
        'bytes',
        'created_at',
      ],
      daily_stats: [
        'date',
        'photographer_id',
        'visitors',
        'scanners',
        'scans',
        'downloads',
        'unique_downloaders',
        'bytes_out',
      ],
      audit_log: ['id', 'actor_id', 'action', 'target_type', 'target_id', 'meta', 'created_at'],
    };
    for (const [table, columns] of Object.entries(expected)) {
      const actual = config(table).columns.map((c) => c.name);
      expect(actual, table).toEqual(expect.arrayContaining(columns));
    }
  });

  it('builds every enum from the @shotx/shared value sets', () => {
    expect(schema.userRole.enumValues).toEqual([...USER_ROLES]);
    expect(schema.authPool.enumValues).toEqual([...AUTH_POOLS]);
    expect(schema.subscriptionStatus.enumValues).toEqual([...SUBSCRIPTION_STATUSES]);
    expect(schema.billingMode.enumValues).toEqual([...BILLING_MODES]);
    expect(schema.paymentMethod.enumValues).toEqual([...PAYMENT_METHODS]);
    expect(schema.paymentStatus.enumValues).toEqual([...PAYMENT_STATUSES]);
    expect(schema.fileStatus.enumValues).toEqual([...FILE_STATUSES]);
    expect(schema.shareTargetType.enumValues).toEqual([...SHARE_TARGET_TYPES]);
    expect(schema.shareMode.enumValues).toEqual([...SHARE_MODES]);
    expect(schema.downloadSize.enumValues).toEqual([...DOWNLOAD_SIZES]);
    expect(schema.faceFeedbackVerdict.enumValues).toEqual([...FACE_FEEDBACK_VERDICTS]);
    expect(schema.activityType.enumValues).toEqual([...ACTIVITY_TYPES]);
  });

  it('uses bigint for byte counts and integer satang for money', () => {
    for (const [table, name] of [
      ['plans', 'quota_bytes'],
      ['storage_usage', 'used_bytes'],
      ['storage_usage', 'reserved_bytes'],
      ['files', 'size_bytes'],
      ['activity_events', 'bytes'],
      ['daily_stats', 'bytes_out'],
    ] as const) {
      expect(column(table, name).getSQLType(), `${table}.${name}`).toBe('bigint');
    }
    for (const [table, name] of [
      ['plans', 'price_month_satang'],
      ['plans', 'price_year_satang'],
      ['payments', 'amount_satang'],
      ['payments', 'vat_satang'],
    ] as const) {
      expect(column(table, name).getSQLType(), `${table}.${name}`).toBe('integer');
    }
  });

  it('stores folder paths as ltree with a GiST index', () => {
    expect(column('folders', 'path').getSQLType()).toBe('ltree');
    const gist = config('folders').indexes.find((i) => i.config.name === 'folders_path_gist');
    expect(gist?.config.method).toBe('gist');
  });

  it('has the unique constraints the spec requires', () => {
    const uniques = (table: string) =>
      config(table).uniqueConstraints.map((u) => ({
        name: u.name,
        columns: u.columns.map((c) => c.name),
      }));
    expect(uniques('payments')).toContainEqual({
      name: 'payments_gateway_ref_unique',
      columns: ['gateway', 'gateway_ref'],
    });
    expect(uniques('faces')).toContainEqual({
      name: 'faces_rekognition_face_id_unique',
      columns: ['rekognition_face_id'],
    });
    expect(uniques('shares')).toContainEqual({
      name: 'shares_token_unique',
      columns: ['token'],
    });
    expect(uniques('plans')).toContainEqual({ name: 'plans_code_unique', columns: ['code'] });
  });

  it('keys users on (Cognito pool, sub) and ties admin to the admins pool', () => {
    const users = config('users');
    expect(
      users.uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)]),
    ).toContainEqual(['users_cognito_identity_unique', ['cognito_pool', 'cognito_sub']]);
    expect(users.checks.map((c) => c.name)).toContain('users_admin_iff_admins_pool');
    expect(column('users', 'cognito_pool').notNull).toBe(true);
    expect(column('users', 'cognito_sub').notNull).toBe(true);
  });

  it('keeps folders, files and faces within one owner', () => {
    const fks = (table: string) =>
      config(table).foreignKeys.map((fk) => {
        const ref = fk.reference();
        return {
          name: fk.getName(),
          columns: ref.columns.map((c) => c.name),
          foreignTable: getTableName(ref.foreignTable),
          foreignColumns: ref.foreignColumns.map((c) => c.name),
        };
      });
    expect(fks('folders')).toContainEqual({
      name: 'folders_parent_same_owner_fk',
      columns: ['parent_id', 'owner_id'],
      foreignTable: 'folders',
      foreignColumns: ['id', 'owner_id'],
    });
    expect(fks('files')).toContainEqual({
      name: 'files_folder_same_owner_fk',
      columns: ['folder_id', 'owner_id'],
      foreignTable: 'folders',
      foreignColumns: ['id', 'owner_id'],
    });
    expect(fks('faces')).toContainEqual({
      name: 'faces_file_same_owner_fk',
      columns: ['file_id', 'owner_id'],
      foreignTable: 'files',
      foreignColumns: ['id', 'owner_id'],
    });
    const facesFk = config('faces').foreignKeys.find(
      (fk) => fk.getName() === 'faces_file_same_owner_fk',
    );
    expect(facesFk?.onDelete).toBe('restrict');
  });

  it('gives activity_events a primary key that includes the partition key', () => {
    const [pk] = config('activity_events').primaryKeys;
    expect(pk?.columns.map((c) => c.name)).toEqual(['id', 'created_at']);
    expect(config('activity_events').foreignKeys).toEqual([]);
  });
});
