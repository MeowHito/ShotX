import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import { activitySource, activityType } from './enums';
import { shares } from './sharing';

/** Counts attached to an event, e.g. a scan's `{ selfies, strong, maybe }`. Never biometrics. */
export type ActivityCounts = Record<string, number>;

/**
 * Raw activity: one row per issued view page, download or zip URL and per scan. Writers validate
 * rows with `activityEventInputSchema` from @shotx/shared (counts only).
 *
 * `source` (migration 0003): `share` rows have `share_id`; `owner` rows are a photographer's
 * downloads from their own drive and have no share and no viewer (`activity_events_source_share`).
 * Viewer rollups count `share` rows only; `bytes_out` counts both (see ACTIVITY_SOURCES).
 *
 * PARTITIONED BY RANGE (created_at), one partition per calendar month (UTC) plus a default
 * partition. Drizzle can't express partitioning, so migration 0000 creates the table by hand and
 * adds `activity_events_ensure_partitions(from, months_ahead)`, which creates missing monthly
 * partitions and moves any rows the default partition caught for those months. The hourly
 * `stats.rollup.hourly` job should call it every run so future months always exist.
 *
 * No foreign keys: the table is append-only and hot, and purges must not have to touch it.
 * `file_id` is null for scans (counts only) and zips (many files). Dashboards read daily_stats,
 * never this table.
 */
export const activityEvents = pgTable(
  'activity_events',
  {
    id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity(),
    type: activityType('type').notNull(),
    source: activitySource('source').notNull().default('share'),
    /** Null exactly for `owner` events. */
    shareId: uuid('share_id'),
    fileId: uuid('file_id'),
    photographerId: uuid('photographer_id').notNull(),
    viewerId: uuid('viewer_id'),
    anonId: uuid('anon_id'),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    meta: jsonb('meta').$type<ActivityCounts>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'activity_events_pkey', columns: [t.id, t.createdAt] }),
    index('activity_events_photographer_created_idx').on(t.photographerId, t.createdAt),
    index('activity_events_share_created_idx').on(t.shareId, t.createdAt),
    index('activity_events_created_brin').using('brin', t.createdAt),
    check('activity_events_bytes_nonnegative', sql`${t.bytes} >= 0`),
    // Unqualified column names: PostgreSQL rejects table-qualified names in a CHECK added to a
    // partitioned table (it is copied to every partition, which has another name).
    check(
      'activity_events_source_share',
      sql`("source" = 'share') = ("share_id" IS NOT NULL) AND ("source" = 'share' OR ("viewer_id" IS NULL AND "anon_id" IS NULL))`,
    ),
  ],
);

/**
 * Hourly rollup of activity_events per photographer and day. `date` is the calendar day in
 * Asia/Bangkok, the operator's time zone (the schedules run in it too).
 */
export const dailyStats = pgTable(
  'daily_stats',
  {
    date: date('date', { mode: 'string' }).notNull(),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    visitors: integer('visitors').notNull().default(0),
    scanners: integer('scanners').notNull().default(0),
    scans: integer('scans').notNull().default(0),
    downloads: integer('downloads').notNull().default(0),
    uniqueDownloaders: integer('unique_downloaders').notNull().default(0),
    bytesOut: bigint('bytes_out', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'daily_stats_pkey', columns: [t.date, t.photographerId] }),
    index('daily_stats_photographer_date_idx').on(t.photographerId, t.date),
    check(
      'daily_stats_nonnegative',
      sql`${t.visitors} >= 0 AND ${t.scanners} >= 0 AND ${t.scans} >= 0 AND ${t.downloads} >= 0 AND ${t.uniqueDownloaders} >= 0 AND ${t.bytesOut} >= 0`,
    ),
  ],
);

/**
 * Hourly rollup of `share` activity per share and day (Bangkok calendar day, as daily_stats), for
 * `GET /shares/:id/stats`. Same counts as daily_stats plus `zips`. The rollup upserts the rows of
 * the days it touched and sets `updated_at`. Deleting a share (purge) deletes its rows.
 */
export const shareDailyStats = pgTable(
  'share_daily_stats',
  {
    shareId: uuid('share_id').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    photographerId: uuid('photographer_id').notNull(),
    visitors: integer('visitors').notNull().default(0),
    scanners: integer('scanners').notNull().default(0),
    scans: integer('scans').notNull().default(0),
    downloads: integer('downloads').notNull().default(0),
    uniqueDownloaders: integer('unique_downloaders').notNull().default(0),
    zips: integer('zips').notNull().default(0),
    bytesOut: bigint('bytes_out', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'share_daily_stats_pkey', columns: [t.shareId, t.date] }),
    foreignKey({
      name: 'share_daily_stats_share_same_owner_fk',
      columns: [t.shareId, t.photographerId],
      foreignColumns: [shares.id, shares.ownerId],
    }).onDelete('cascade'),
    index('share_daily_stats_photographer_date_idx').on(t.photographerId, t.date),
    check(
      'share_daily_stats_nonnegative',
      sql`${t.visitors} >= 0 AND ${t.scanners} >= 0 AND ${t.scans} >= 0 AND ${t.downloads} >= 0 AND ${t.uniqueDownloaders} >= 0 AND ${t.zips} >= 0 AND ${t.bytesOut} >= 0`,
    ),
  ],
);

/**
 * Every admin action and every admin sign-in. Append-only by convention: nothing updates or
 * deletes rows. `actor_id` may be null only for sign-in events (`auth.` actions, see
 * AUTH_AUDIT_ACTIONS in @shotx/shared), e.g. a failed sign-in for an email that matches no admin
 * (migration 0005), and package gateway events (`package.` actions, PACKAGE_AUDIT_ACTIONS, migration
 * 0016), e.g. an amount mismatch on an order whose buyer has no account yet.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorId: uuid('actor_id').references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_actor_created_idx').on(t.actorId, t.createdAt),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    // Migration 0017 (ADR 0027, the audit-log viewer): newest first with an id tiebreak (replaces
    // the plain created_at index of the same name), the action filter (exact, or a `LIKE 'x.%'`
    // prefix: text_pattern_ops), and target ids alone (audit_log_target_idx leads with the type).
    index('audit_log_created_idx').on(t.createdAt.desc(), t.id.desc()),
    index('audit_log_action_idx').on(
      t.action.op('text_pattern_ops'),
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('audit_log_target_id_idx').on(t.targetId, t.createdAt.desc(), t.id.desc()),
    // Migration 0016 (ADR 0026): `package.` actions (gateway callbacks) may have no actor too. The
    // name is kept from migration 0005 so nothing that maps it changes.
    check(
      'audit_log_actor_unless_auth_event',
      sql`${t.actorId} IS NOT NULL OR ${t.action} LIKE 'auth.%' OR ${t.action} LIKE 'package.%'`,
    ),
  ],
);
