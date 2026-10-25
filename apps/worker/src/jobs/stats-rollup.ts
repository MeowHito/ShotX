import { sql } from 'drizzle-orm';
import { rows } from '../db';
import type { JobContext } from './context';

/**
 * The calendar the rollups use: `daily_stats.date` and `share_daily_stats.date` are days in
 * Asia/Bangkok, the operator's time zone (packages/db analytics schema).
 */
export const STATS_TIME_ZONE = 'Asia/Bangkok';

export interface StatsRollupResult {
  /** First and last Bangkok day recomputed (YYYY-MM-DD). */
  from: string;
  to: string;
  partitionsCreated: number;
  dailyRows: number;
  shareRows: number;
}

/** A viewer or anonymous session, for the distinct counts (exactly one is set on share rows). */
const PERSON = sql.raw(`COALESCE('u:' || "e"."viewer_id"::text, 'a:' || "e"."anon_id"::text)`);

/**
 * `stats.rollup.hourly`. Every run:
 *
 * 1. `SELECT activity_events_ensure_partitions()`, so next months' partitions always exist.
 * 2. Recomputes yesterday and today (Bangkok days, relative to the run) from `activity_events`,
 *    in one transaction: their `share_daily_stats` and `daily_stats` rows are deleted and rebuilt.
 *    Every day is recomputed by every run during it and the next day (48 hourly chances), so late
 *    rows and a missed run are both covered, and running twice gives the same rows.
 *
 * Metrics (ACTIVITY_SOURCES): people counts and event counts come from `share` events only;
 * `bytes_out` sums download and zip bytes of both `share` and `owner` events in daily_stats, and of
 * the share's own events in share_daily_stats.
 *
 * - visitors: distinct people with a `view`; scanners: distinct people with a `scan`;
 *   scans: `scan` events; downloads: `download` events (single-file URLs);
 *   unique_downloaders: distinct people with a `download` or `zip`; zips (share only): `zip`.
 *
 * Events of shares or photographers that no longer exist are skipped (their rows were deleted
 * by the purge's cascade). The time-range filter on `created_at` keeps partition pruning.
 */
export async function runStatsRollup(ctx: JobContext): Promise<StatsRollupResult> {
  const [partitions] = await rows<{ created: number }>(
    ctx.db,
    sql`SELECT activity_events_ensure_partitions() AS "created"`,
  );
  const now = new Date(ctx.now()).toISOString();
  // A constant inlined as a literal: GROUP BY must see the same expression as the SELECT list,
  // which separate bind parameters would break.
  const tz = sql.raw(`'${STATS_TIME_ZONE}'`);
  const [range] = await rows<{ from_day: string; to_day: string }>(
    ctx.db,
    sql`SELECT
        (((${now}::timestamptz AT TIME ZONE ${tz})::date) - 1)::text AS "from_day",
        ((${now}::timestamptz AT TIME ZONE ${tz})::date)::text AS "to_day"`,
  );
  const fromDay = range!.from_day;
  const toDay = range!.to_day;
  // Start of the first day and of the day after the last, as instants.
  const start = sql`(${fromDay}::date::timestamp AT TIME ZONE ${tz})`;
  const end = sql`((${toDay}::date + 1)::timestamp AT TIME ZONE ${tz})`;
  const day = sql`(("e"."created_at" AT TIME ZONE ${tz})::date)`;

  const counts = await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM "share_daily_stats" WHERE "date" BETWEEN ${fromDay}::date AND ${toDay}::date`,
    );
    const shareRows = await rows<{ share_id: string }>(
      tx,
      sql`INSERT INTO "share_daily_stats" ("share_id", "date", "photographer_id", "visitors",
          "scanners", "scans", "downloads", "unique_downloaders", "zips", "bytes_out", "updated_at")
        SELECT "e"."share_id", ${day}, "e"."photographer_id",
          count(DISTINCT ${PERSON}) FILTER (WHERE "e"."type" = 'view'),
          count(DISTINCT ${PERSON}) FILTER (WHERE "e"."type" = 'scan'),
          count(*) FILTER (WHERE "e"."type" = 'scan'),
          count(*) FILTER (WHERE "e"."type" = 'download'),
          count(DISTINCT ${PERSON}) FILTER (WHERE "e"."type" IN ('download', 'zip')),
          count(*) FILTER (WHERE "e"."type" = 'zip'),
          COALESCE(sum("e"."bytes") FILTER (WHERE "e"."type" IN ('download', 'zip')), 0),
          now()
        FROM "activity_events" AS "e"
        JOIN "shares" AS "s" ON "s"."id" = "e"."share_id" AND "s"."owner_id" = "e"."photographer_id"
        WHERE "e"."source" = 'share' AND "e"."created_at" >= ${start} AND "e"."created_at" < ${end}
        GROUP BY "e"."share_id", ${day}, "e"."photographer_id"
        RETURNING "share_id"`,
    );
    await tx.execute(
      sql`DELETE FROM "daily_stats" WHERE "date" BETWEEN ${fromDay}::date AND ${toDay}::date`,
    );
    const dailyRows = await rows<{ photographer_id: string }>(
      tx,
      sql`INSERT INTO "daily_stats" ("date", "photographer_id", "visitors", "scanners", "scans",
          "downloads", "unique_downloaders", "bytes_out")
        SELECT ${day}, "e"."photographer_id",
          count(DISTINCT ${PERSON}) FILTER (WHERE "e"."source" = 'share' AND "e"."type" = 'view'),
          count(DISTINCT ${PERSON}) FILTER (WHERE "e"."source" = 'share' AND "e"."type" = 'scan'),
          count(*) FILTER (WHERE "e"."source" = 'share' AND "e"."type" = 'scan'),
          count(*) FILTER (WHERE "e"."source" = 'share' AND "e"."type" = 'download'),
          count(DISTINCT ${PERSON}) FILTER (WHERE "e"."source" = 'share' AND "e"."type" IN ('download', 'zip')),
          COALESCE(sum("e"."bytes") FILTER (WHERE "e"."type" IN ('download', 'zip')), 0)
        FROM "activity_events" AS "e"
        JOIN "users" AS "u" ON "u"."id" = "e"."photographer_id"
        WHERE "e"."created_at" >= ${start} AND "e"."created_at" < ${end}
        GROUP BY ${day}, "e"."photographer_id"
        RETURNING "photographer_id"`,
    );
    return { shareRows: shareRows.length, dailyRows: dailyRows.length };
  });
  return {
    from: fromDay,
    to: toDay,
    partitionsCreated: Number(partitions?.created ?? 0),
    ...counts,
  };
}
