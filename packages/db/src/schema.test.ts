import {
  ACCOUNT_STATUSES,
  ACTIVITY_TYPES,
  PACKAGE_KINDS,
  PACKAGE_ORDER_STATUSES,
  AUTH_POOLS,
  BILLING_ACTORS,
  BILLING_MODES,
  CHECKOUT_CHANGE_TYPES,
  CHECKOUT_STATUSES,
  CONSENT_PURPOSES,
  DOWNLOAD_SIZES,
  EXPENSE_CATEGORIES,
  FACE_FEEDBACK_VERDICTS,
  FILE_STATUSES,
  PAYMENT_EVENT_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SHARE_MODES,
  SHARE_TARGET_TYPES,
  SUBSCRIPTION_EVENT_TYPES,
  SUBSCRIPTION_NOTICE_KINDS,
  SUBSCRIPTION_STATUSES,
  USER_ROLES,
  ZIP_JOB_STATUSES,
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
        'zip_jobs',
        'zip_job_entries',
        'face_deletions',
        'share_daily_stats',
        'checkout_sessions',
        'payment_webhook_events',
        'subscription_notices',
        'subscription_events',
        'auth_sessions',
        'admin_credentials',
        'face_vectors',
        'user_password_credentials',
        'cash_payments',
        'share_designs',
        'design_assets',
        'packages',
        'photographer_packages',
        'package_orders',
        'expenses',
        'package_coupons',
        'print_settings',
        'print_orders',
      ].sort(),
    );
  });

  it('has the data-model columns of every table', () => {
    const expected: Record<string, string[]> = {
      users: [
        'id',
        'email',
        'name',
        'role',
        'auth_pool',
        'auth_subject',
        'created_at',
        'status',
        'disabled_at',
        'created_by_id',
        'last_sign_in_at',
      ],
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
        'target_file_id',
        'target_folder_id',
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
      auth_sessions: [
        'id',
        'user_id',
        'pool',
        'refresh_token_hash',
        'family_id',
        'expires_at',
        'revoked_at',
        'replaced_by_id',
        'created_at',
        'last_used_at',
      ],
      admin_credentials: [
        'user_id',
        'password_hash',
        'totp_secret_encrypted',
        'totp_secret_nonce',
        'totp_confirmed_at',
        'totp_last_used_step',
        'failed_attempts',
        'locked_until',
        'created_at',
        'updated_at',
        'must_change_password',
      ],
      user_password_credentials: [
        'user_id',
        'auth_pool',
        'password_hash',
        'must_change_password',
        'failed_attempts',
        'locked_until',
        'password_changed_at',
        'created_at',
        'updated_at',
      ],
      cash_payments: [
        'id',
        'photographer_id',
        'amount_satang',
        'paid_at',
        'note',
        'recorded_by_id',
        'created_at',
      ],
      zip_jobs: [
        'id',
        'photographer_id',
        'share_id',
        'viewer_id',
        'anon_id',
        'download_size',
        'status',
        'file_count',
        'total_bytes',
        'idempotency_key',
        'result_key',
        'error_code',
        'error_message',
        'created_at',
        'started_at',
        'completed_at',
        'expires_at',
      ],
      zip_job_entries: ['job_id', 'photographer_id', 'position', 'file_id', 'name'],
      // ADR 0013.
      share_designs: [
        'id',
        'owner_id',
        'name',
        'doc',
        'revision',
        'is_default',
        'created_at',
        'updated_at',
      ],
      design_assets: [
        'id',
        'owner_id',
        'mime',
        'size_bytes',
        'width',
        'height',
        'status',
        'created_at',
      ],
      face_vectors: [
        'face_id',
        'collection_id',
        'external_image_id',
        'model',
        'embedding',
        'created_at',
      ],
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
    expect(schema.zipJobStatus.enumValues).toEqual([...ZIP_JOB_STATUSES]);
    expect(schema.consentPurpose.enumValues).toEqual([...CONSENT_PURPOSES]);
    expect(schema.checkoutChangeType.enumValues).toEqual([...CHECKOUT_CHANGE_TYPES]);
    expect(schema.checkoutStatus.enumValues).toEqual([...CHECKOUT_STATUSES]);
    expect(schema.paymentEventType.enumValues).toEqual([...PAYMENT_EVENT_TYPES]);
    expect(schema.subscriptionEventType.enumValues).toEqual([...SUBSCRIPTION_EVENT_TYPES]);
    expect(schema.subscriptionNoticeKind.enumValues).toEqual([...SUBSCRIPTION_NOTICE_KINDS]);
    expect(schema.billingActor.enumValues).toEqual([...BILLING_ACTORS]);
    expect(schema.accountStatus.enumValues).toEqual([...ACCOUNT_STATUSES]);
    expect(schema.packageOrderStatus.enumValues).toEqual([...PACKAGE_ORDER_STATUSES]);
    expect(schema.packageKind.enumValues).toEqual([...PACKAGE_KINDS]);
    expect(schema.expenseCategory.enumValues).toEqual([...EXPENSE_CATEGORIES]);
  });

  it('has the expenses ledger and the finance indexes of migration 0017 (ADR 0027)', () => {
    expect(config('expenses').columns.map((c) => c.name)).toEqual([
      'id',
      'spent_on',
      'amount_satang',
      'category',
      'note',
      'recorded_by_id',
      'recorded_by_pool',
      'created_at',
      'deleted_at',
    ]);
    expect(config('expenses').checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'expenses_recorded_by_pool',
        'expenses_amount_positive',
        'expenses_note_length',
        'expenses_spent_on_not_future',
      ]),
    );
    expect(config('expenses').foreignKeys.map((f) => f.getName())).toEqual([
      'expenses_recorded_by_admin_fk',
    ]);
    const indexes = (table: string) => config(table).indexes.map((i) => i.config.name);
    expect(indexes('expenses')).toEqual(['expenses_spent_on_idx']);
    expect(indexes('package_orders')).toContain('package_orders_paid_idx');
    expect(indexes('audit_log')).toEqual(
      expect.arrayContaining([
        'audit_log_created_idx',
        'audit_log_action_idx',
        'audit_log_actor_created_idx',
        'audit_log_target_id_idx',
      ]),
    );
    expect(indexes('cash_payments')).toContain('cash_payments_paid_idx');
  });

  it('has the package tables of migration 0016 (ADR 0026)', () => {
    const names = (table: string) => config(table).columns.map((c) => c.name);
    expect(names('packages')).toEqual([
      'id',
      'code',
      'name',
      'kind',
      'days',
      'photo_limit',
      'price_satang',
      'is_active',
      'sort_order',
    ]);
    expect(names('photographer_packages')).toEqual(
      expect.arrayContaining([
        'photographer_id',
        'package_id',
        'starts_at',
        'expires_at',
        'photo_limit',
        'photos_used',
        'updated_at',
      ]),
    );
    expect(names('package_orders')).toEqual(
      expect.arrayContaining([
        'id',
        'package_id',
        'photographer_id',
        'email',
        'name',
        'price_satang',
        'vat_satang',
        'total_satang',
        'gateway',
        'gateway_ref',
        'status',
        'access_token_hash',
        'idempotency_key',
        'paid_at',
        'applied_at',
        'created_at',
        'updated_at',
      ]),
    );
    for (const [table, col] of [
      ['packages', 'price_satang'],
      ['package_orders', 'price_satang'],
      ['package_orders', 'vat_satang'],
      ['package_orders', 'total_satang'],
    ] as const) {
      expect(column(table, col).getSQLType(), `${table}.${col}`).toBe('integer');
    }
    expect(config('photographer_packages').primaryKeys).toEqual([]);
    expect(column('photographer_packages', 'photographer_id').primary).toBe(true);
    expect(column('package_orders', 'photographer_id').notNull).toBe(false);
    expect(column('package_orders', 'status').getSQLType()).toBe('package_order_status');
    const uniques = (table: string) =>
      config(table).uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)]);
    expect(uniques('package_orders')).toEqual(
      expect.arrayContaining([
        ['package_orders_gateway_ref_unique', ['gateway', 'gateway_ref']],
        ['package_orders_idempotency_key_unique', ['idempotency_key']],
      ]),
    );
    expect(uniques('packages')).toContainEqual(['packages_code_unique', ['code']]);
    const checks = (table: string) => config(table).checks.map((c) => c.name);
    expect(checks('packages')).toEqual(
      expect.arrayContaining([
        'packages_kind_terms',
        'packages_free_is_plan',
        'packages_price_nonnegative',
      ]),
    );
    expect(checks('photographer_packages')).toEqual(
      expect.arrayContaining([
        'photographer_packages_period_order',
        'photographer_packages_photos_used_nonnegative',
      ]),
    );
    // Extensions can leave photos_used above an old limit for a moment: the guard is the UPDATE.
    expect(checks('photographer_packages').join(' ')).not.toMatch(/photos_used_within/);
    expect(checks('package_orders')).toEqual(
      expect.arrayContaining([
        'package_orders_amounts_valid',
        'package_orders_total_is_price_plus_vat',
        'package_orders_access_token_hash_hex',
      ]),
    );
    expect(config('package_orders').indexes.map((i) => i.config.name)).toEqual(
      expect.arrayContaining([
        'package_orders_photographer_created_idx',
        'package_orders_email_idx',
        'package_orders_coupon_idx',
      ]),
    );
    // ADR 0030: coupons.
    expect(names('package_orders')).toEqual(
      expect.arrayContaining(['coupon_id', 'coupon_code', 'discount_satang']),
    );
    expect(column('package_orders', 'discount_satang').default).toBe(0);
    expect(uniques('package_coupons')).toContainEqual(['package_coupons_code_unique', ['code']]);
    expect(checks('package_coupons')).toEqual(
      expect.arrayContaining([
        'package_coupons_code_format',
        'package_coupons_percent_off_range',
        'package_coupons_max_redemptions_positive',
        'package_coupons_created_by_pool',
      ]),
    );
    expect(checks('package_orders')).toContain('package_orders_coupon_consistent');
  });

  it('has the account columns, keys and checks of migration 0011 (ADR 0010)', () => {
    expect(column('users', 'status').notNull).toBe(true);
    expect(column('users', 'status').default).toBe('active');
    expect(column('users', 'disabled_at').notNull).toBe(false);
    expect(column('admin_credentials', 'must_change_password').default).toBe(false);
    expect(column('admin_credentials', 'totp_secret_encrypted').notNull).toBe(false);
    expect(column('admin_credentials', 'totp_secret_nonce').notNull).toBe(false);
    expect(column('user_password_credentials', 'must_change_password').default).toBe(true);
    expect(column('cash_payments', 'amount_satang').getSQLType()).toBe('integer');
    const checks = (table: string) => config(table).checks.map((c) => c.name);
    expect(checks('users')).toEqual(
      expect.arrayContaining([
        'users_disabled_at_iff_disabled',
        'users_password_subject_photographer',
        'users_admin_subject_admins_pool',
        'users_password_account_has_email',
      ]),
    );
    expect(checks('admin_credentials')).toEqual(
      expect.arrayContaining([
        'admin_credentials_totp_secret_complete',
        'admin_credentials_totp_state_needs_secret',
      ]),
    );
    expect(checks('user_password_credentials')).toEqual(
      expect.arrayContaining([
        'user_password_credentials_users_pool',
        'user_password_credentials_password_argon2id',
      ]),
    );
    expect(checks('cash_payments')).toEqual(
      expect.arrayContaining(['cash_payments_amount_positive', 'cash_payments_note_length']),
    );
    const usersIndex = (name: string) =>
      config('users').indexes.find((i) => i.config.name === name);
    expect(usersIndex('users_password_account_email_unique')?.config.unique).toBe(true);
    expect(usersIndex('users_admin_email_unique')?.config.unique).toBe(true);
    const fk = (table: string, name: string) => {
      const found = config(table).foreignKeys.find((f) => f.getName() === name);
      if (found === undefined) throw new Error(`no fk ${name}`);
      const ref = found.reference();
      return {
        columns: ref.columns.map((c) => c.name),
        foreignColumns: ref.foreignColumns.map((c) => c.name),
        onDelete: found.onDelete,
      };
    };
    expect(fk('user_password_credentials', 'user_password_credentials_user_fk')).toEqual({
      columns: ['user_id', 'auth_pool'],
      foreignColumns: ['id', 'auth_pool'],
      onDelete: 'cascade',
    });
    expect(fk('cash_payments', 'cash_payments_recorded_by_admin_fk').columns).toEqual([
      'recorded_by_id',
      'recorded_by_pool',
    ]);
    expect(fk('users', 'users_created_by_id_users_id_fk').onDelete).toBe('set null');
    expect(
      config('cash_payments').uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)]),
    ).toContainEqual(['cash_payments_idempotency_unique', ['recorded_by_id', 'idempotency_key']]);
    expect(config('cash_payments').indexes.map((i) => i.config.name)).toEqual(
      expect.arrayContaining(['cash_payments_photographer_paid_idx', 'cash_payments_paid_idx']),
    );
  });

  it('has the billing columns, checks and unique keys of migration 0004', () => {
    const names = (table: string) => config(table).columns.map((c) => c.name);
    expect(names('subscriptions')).toEqual(
      expect.arrayContaining([
        'period_start',
        'auto_renew_months',
        'payment_method_gateway',
        'payment_method_ref',
        'pending_plan_id',
        'pending_plan_effective_at',
        'updated_at',
      ]),
    );
    // Never card data: only the gateway's reference to a saved method.
    for (const table of ['subscriptions', 'payments', 'checkout_sessions']) {
      expect(
        names(table).filter((n) => /card|pan|cvv|last4|expiry_month/.test(n)),
        table,
      ).toEqual([]);
    }
    expect(column('payments', 'photographer_id').notNull).toBe(true);
    expect(column('payments', 'subscription_id').notNull).toBe(false);
    expect(column('consents', 'purpose').notNull).toBe(true);
    for (const [table, name] of [
      ['checkout_sessions', 'amount_satang'],
      ['checkout_sessions', 'vat_satang'],
      ['checkout_sessions', 'proration_satang'],
      ['payment_webhook_events', 'amount_satang'],
    ] as const) {
      expect(column(table, name).getSQLType(), `${table}.${name}`).toBe('integer');
    }
    const uniques = (table: string) =>
      config(table).uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)]);
    expect(uniques('checkout_sessions')).toContainEqual([
      'checkout_sessions_idempotency_unique',
      ['photographer_id', 'idempotency_key'],
    ]);
    expect(uniques('payment_webhook_events')).toContainEqual([
      'payment_webhook_events_event_unique',
      ['gateway', 'event_ref'],
    ]);
    const uniqueIndex = (table: string, name: string) =>
      config(table).indexes.find((i) => i.config.name === name)?.config.unique;
    expect(uniqueIndex('checkout_sessions', 'checkout_sessions_one_pending_per_photographer')).toBe(
      true,
    );
    expect(uniqueIndex('payments', 'payments_one_open_renewal')).toBe(true);
    expect(uniqueIndex('payments', 'payments_checkout_unique')).toBe(true);
    const consentIndex = config('consents').indexes.find(
      (i) => i.config.name === 'consents_current_anon_unique',
    );
    expect(consentIndex?.config.columns.map((c) => ('name' in c ? c.name : null))).toEqual([
      'share_id',
      'anon_id',
      'purpose',
      'policy_version',
    ]);
    expect(config('subscriptions').checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'subscriptions_auto_renew_has_method',
        'subscriptions_pending_plan_complete',
        'subscriptions_period_order',
      ]),
    );
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
      ['checkout_sessions', 'amount_satang'],
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

  it('makes live drive names unique per owner and parent, and indexes children listings', () => {
    const indexNames = (table: string) => config(table).indexes.map((i) => i.config.name);
    const unique = (table: string, name: string) =>
      config(table).indexes.find((i) => i.config.name === name)?.config.unique;
    expect(unique('folders', 'folders_live_name_unique')).toBe(true);
    expect(unique('files', 'files_live_name_unique')).toBe(true);
    expect(unique('zip_job_entries', 'zip_job_entries_name_folded_unique')).toBe(true);
    expect(indexNames('folders')).toEqual(
      expect.arrayContaining([
        'folders_children_name_idx',
        'folders_children_id_idx',
        'folders_trash_idx',
      ]),
    );
    expect(indexNames('files')).toEqual(
      expect.arrayContaining([
        'files_children_name_idx',
        'files_children_id_idx',
        'files_trash_idx',
        'files_upload_expiry_idx',
      ]),
    );
    expect(config('zip_job_entries').uniqueConstraints.map((u) => u.name)).not.toContain(
      'zip_job_entries_name_unique',
    );
  });

  it('keys users on (auth pool, auth subject) and ties admin to the admins pool', () => {
    const users = config('users');
    const uniques = users.uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)]);
    expect(uniques).toContainEqual(['users_auth_identity_unique', ['auth_pool', 'auth_subject']]);
    expect(uniques).toContainEqual(['users_id_auth_pool_unique', ['id', 'auth_pool']]);
    expect(users.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['users_admin_iff_admins_pool', 'users_auth_subject_not_empty']),
    );
    expect(users.indexes.map((i) => i.config.name)).toContain('users_admin_email_unique');
    expect(column('users', 'auth_pool').notNull).toBe(true);
    expect(column('users', 'auth_subject').notNull).toBe(true);
  });

  it('ties auth sessions and admin credentials to their user and pool', () => {
    const fk = (table: string, name: string) => {
      const found = config(table).foreignKeys.find((f) => f.getName() === name);
      if (found === undefined) throw new Error(`no fk ${name}`);
      const ref = found.reference();
      return {
        columns: ref.columns.map((c) => c.name),
        foreignTable: getTableName(ref.foreignTable),
        foreignColumns: ref.foreignColumns.map((c) => c.name),
        onDelete: found.onDelete,
      };
    };
    expect(fk('auth_sessions', 'auth_sessions_user_pool_fk')).toEqual({
      columns: ['user_id', 'pool'],
      foreignTable: 'users',
      foreignColumns: ['id', 'auth_pool'],
      onDelete: 'cascade',
    });
    expect(fk('admin_credentials', 'admin_credentials_admin_user_fk')).toEqual({
      columns: ['user_id', 'auth_pool'],
      foreignTable: 'users',
      foreignColumns: ['id', 'auth_pool'],
      onDelete: 'cascade',
    });
    expect(config('auth_sessions').indexes.map((i) => i.config.name)).toContain(
      'auth_sessions_family_idx',
    );
    expect(column('audit_log', 'actor_id').notNull).toBe(false);
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
    expect(fks('shares')).toEqual(
      expect.arrayContaining([
        {
          name: 'shares_target_file_same_owner_fk',
          columns: ['target_file_id', 'owner_id'],
          foreignTable: 'files',
          foreignColumns: ['id', 'owner_id'],
        },
        {
          name: 'shares_target_folder_same_owner_fk',
          columns: ['target_folder_id', 'owner_id'],
          foreignTable: 'folders',
          foreignColumns: ['id', 'owner_id'],
        },
      ]),
    );
    expect(config('shares').columns.map((c) => c.name)).not.toContain('target_id');
    expect(fks('zip_jobs')).toContainEqual({
      name: 'zip_jobs_share_same_owner_fk',
      columns: ['share_id', 'photographer_id'],
      foreignTable: 'shares',
      foreignColumns: ['id', 'owner_id'],
    });
    expect(fks('zip_job_entries')).toEqual(
      expect.arrayContaining([
        {
          name: 'zip_job_entries_job_same_photographer_fk',
          columns: ['job_id', 'photographer_id'],
          foreignTable: 'zip_jobs',
          foreignColumns: ['id', 'photographer_id'],
        },
        {
          name: 'zip_job_entries_file_same_photographer_fk',
          columns: ['file_id', 'photographer_id'],
          foreignTable: 'files',
          foreignColumns: ['id', 'owner_id'],
        },
      ]),
    );
    const facesFk = config('faces').foreignKeys.find(
      (fk) => fk.getName() === 'faces_file_same_owner_fk',
    );
    expect(facesFk?.onDelete).toBe('restrict');
  });

  it('has the share page designer tables and the share design key of migration 0013 (ADR 0013)', () => {
    expect(column('shares', 'design_id').notNull).toBe(false);
    const designFk = config('shares').foreignKeys.find(
      (fk) => fk.getName() === 'shares_design_same_owner_fk',
    );
    const ref = designFk?.reference();
    expect({
      columns: ref?.columns.map((c) => c.name),
      foreignTable: ref === undefined ? undefined : getTableName(ref.foreignTable),
      foreignColumns: ref?.foreignColumns.map((c) => c.name),
      onDelete: designFk?.onDelete,
    }).toEqual({
      columns: ['design_id', 'owner_id'],
      foreignTable: 'share_designs',
      foreignColumns: ['id', 'owner_id'],
      onDelete: 'set null',
    });
    expect(config('share_designs').uniqueConstraints.map((u) => u.name)).toContain(
      'share_designs_id_owner_unique',
    );
    const defaultIndex = config('share_designs').indexes.find(
      (i) => i.config.name === 'share_designs_one_default_per_owner',
    );
    expect(defaultIndex?.config.unique).toBe(true);
    expect(defaultIndex?.config.where).toBeDefined();
    expect(column('share_designs', 'doc').getSQLType()).toBe('jsonb');
    expect(column('share_designs', 'revision').default).toBe(1);
    expect(column('share_designs', 'is_default').default).toBe(false);
    // Same value set as files (ADR 0013: uploading|processing|ready|failed).
    expect(column('design_assets', 'status').getSQLType()).toBe('file_status');
    expect(column('design_assets', 'size_bytes').getSQLType()).toBe('bigint');
  });

  it('gives activity_events a primary key that includes the partition key', () => {
    const [pk] = config('activity_events').primaryKeys;
    expect(pk?.columns.map((c) => c.name)).toEqual(['id', 'created_at']);
    expect(config('activity_events').foreignKeys).toEqual([]);
  });
});
