import { z } from 'zod';
import { ACTIVITY_SOURCES } from '../domain';

/**
 * Rows of `activity_events`: one per issued view page, download URL and zip URL, and one per
 * scan. Counts only: no face ids, boxes, selfies, similarity scores or file names, ever.
 *
 * - `view`: one per `GET /s/:token/items` page (and per face-search response, which also issues
 *   view URLs) with `meta.items` = URLs' files; `file_id` null, `bytes` 0 (the bytes of
 *   thumbnails and previews are not known when signing).
 * - `scan`: one per face-search request, `meta` = { selfies, strong, maybe }; `file_id` null.
 * - `download`: one per single-file download URL, `file_id` set, `bytes` = the served object's
 *   size: `files.size_bytes` for `original`, `files.web_size_bytes` for `web` (0 when the worker
 *   hasn't recorded it).
 * - `zip`: one per finished-zip URL issued by `GET /zip-jobs/:id`, `meta.files`, `bytes` = the
 *   archive size; `file_id` null.
 *
 * `source = 'share'` rows carry the share and the viewer (`viewer_id` or `anon_id`); `source =
 * 'owner'` rows are a photographer's downloads from their own drive (`share_id`, `viewer_id` and
 * `anon_id` null). See ACTIVITY_SOURCES for what the rollups count.
 *
 * The table is range-partitioned by month (UTC) with a default partition. Writers just insert;
 * `stats.rollup.hourly` calls `activity_events_ensure_partitions()` so future months exist, and
 * rolls rows up into `daily_stats` and `share_daily_stats`. Dashboards never read raw events.
 */

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid();

export const viewActivityMetaSchema = z.strictObject({ items: count });
export const scanActivityMetaSchema = z.strictObject({
  selfies: count,
  strong: count,
  maybe: count,
});
export const zipActivityMetaSchema = z.strictObject({ files: count });

const shareSource = {
  source: z.literal('share'),
  shareId: uuid,
  photographerId: uuid,
  viewerId: uuid.nullable(),
  anonId: uuid.nullable(),
};

/** What a writer passes for one event; the database fills `id` and `created_at`. */
export const activityEventInputSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('view'),
      ...shareSource,
      fileId: z.null(),
      bytes: z.literal(0),
      meta: viewActivityMetaSchema,
    }),
    z.strictObject({
      type: z.literal('scan'),
      ...shareSource,
      fileId: z.null(),
      bytes: z.literal(0),
      meta: scanActivityMetaSchema,
    }),
    z.strictObject({
      type: z.literal('download'),
      source: z.enum(ACTIVITY_SOURCES),
      shareId: uuid.nullable(),
      photographerId: uuid,
      viewerId: uuid.nullable(),
      anonId: uuid.nullable(),
      fileId: uuid,
      bytes: count,
      meta: z.null(),
    }),
    z.strictObject({
      type: z.literal('zip'),
      ...shareSource,
      fileId: z.null(),
      bytes: count,
      meta: zipActivityMetaSchema,
    }),
  ])
  .refine((e) => (e.source === 'share') === (e.shareId !== null), {
    error: 'shareId is required for share events and must be null for owner events',
  })
  .refine((e) => e.source === 'share' || (e.viewerId === null && e.anonId === null), {
    error: 'owner events carry no viewer',
  })
  .refine((e) => e.source === 'owner' || (e.viewerId === null) !== (e.anonId === null), {
    error: 'a share event has exactly one of viewerId and anonId',
  });
export type ActivityEventInput = z.output<typeof activityEventInputSchema>;
