import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id } from './columns';
import { activityType } from './enums';

/** Counts attached to an event, e.g. a scan's `{ selfies, strong, maybe }`. Never biometrics. */
export type ActivityCounts = Record<string, number>;

/**
 * Raw activity: one row per issued view, download or zip URL and per scan.
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
    shareId: uuid('share_id').notNull(),
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

/** Every admin action. Append-only by convention: nothing updates or deletes rows. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_actor_created_idx').on(t.actorId, t.createdAt),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    index('audit_log_created_idx').on(t.createdAt),
  ],
);
