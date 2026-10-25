import { ZIP_MAX_FILES_LIMIT } from '@shotx/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, driveNameKeySql, id, timestamptz } from './columns';
import { files } from './drive';
import { downloadSize, zipJobStatus } from './enums';
import { shares } from './sharing';

const maxFiles = sql.raw(String(ZIP_MAX_FILES_LIMIT));

/**
 * Multi-file downloads. `POST /s/:token/downloads` checks the share, scope, face_only grant and
 * limits, then inserts the job and its entries in one transaction and sends `{ jobId }` to the
 * `zip` queue. The worker claims the job (`queued` -> `running`, `attempts + 1`), rebuilds the
 * entries (see `parseZipEntries` in @shotx/shared), streams them into `result_key` with store, and
 * marks it `ready` or `failed`. `GET /zip-jobs/:id` answers only the viewer or session that
 * created it.
 *
 * The share must belong to the photographer (foreign key on (share_id, photographer_id)), and so
 * must every entry's file, so one job can never mix photographers.
 */
export const zipJobs = pgTable(
  'zip_jobs',
  {
    id: id(),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id),
    shareId: uuid('share_id').notNull(),
    /** Who asked: the logged-in viewer, or the anonymous session (`anon_id` cookie). */
    viewerId: uuid('viewer_id').references(() => users.id),
    anonId: uuid('anon_id'),
    /** `web` zips each file's web.jpg (`files.web_key`); `original` zips `files.s3_key`. */
    downloadSize: downloadSize('download_size').notNull(),
    status: zipJobStatus('status').notNull().default('queued'),
    /** Number of `zip_job_entries` rows, so the worker notices entries removed by a purge. */
    fileCount: integer('file_count').notNull(),
    /** Sum of the entries' sizes when requested, checked against ZIP_MAX_BYTES. */
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
    /** The client's `Idempotency-Key` header, unique per share. */
    idempotencyKey: text('idempotency_key'),
    /** Times a worker claimed the job. */
    attempts: integer('attempts').notNull().default(0),
    /** `tmp/zips/{id}.zip` (zipKey in @shotx/shared) once ready. */
    resultKey: text('result_key'),
    resultBytes: bigint('result_bytes', { mode: 'number' }),
    /** Stable code (e.g. an ErrorCode) when failed. */
    errorCode: text('error_code'),
    /** Operator-facing detail when failed. Never file names of other people, never biometrics. */
    errorMessage: text('error_message'),
    createdAt: createdAt(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    /** When the tmp/zips/ object is lifecycle-expired; the API stops issuing URLs after it. */
    expiresAt: timestamptz('expires_at'),
  },
  (t) => [
    unique('zip_jobs_id_photographer_unique').on(t.id, t.photographerId),
    unique('zip_jobs_idempotency_unique').on(t.shareId, t.idempotencyKey),
    foreignKey({
      name: 'zip_jobs_share_same_owner_fk',
      columns: [t.shareId, t.photographerId],
      foreignColumns: [shares.id, shares.ownerId],
    }).onDelete('cascade'),
    index('zip_jobs_share_created_idx').on(t.shareId, t.createdAt),
    index('zip_jobs_photographer_created_idx').on(t.photographerId, t.createdAt),
    index('zip_jobs_status_created_idx').on(t.status, t.createdAt),
    check('zip_jobs_viewer_or_anon', sql`${t.viewerId} IS NOT NULL OR ${t.anonId} IS NOT NULL`),
    check('zip_jobs_file_count_range', sql`${t.fileCount} BETWEEN 1 AND ${maxFiles}`),
    check(
      'zip_jobs_bytes_nonnegative',
      sql`${t.totalBytes} >= 0 AND (${t.resultBytes} IS NULL OR ${t.resultBytes} >= 0) AND ${t.attempts} >= 0`,
    ),
    check(
      'zip_jobs_idempotency_key_format',
      sql`${t.idempotencyKey} IS NULL OR ${t.idempotencyKey} ~ '^[!-~]{1,255}$'`,
    ),
    check(
      'zip_jobs_result_key_is_zip_key',
      sql`${t.resultKey} IS NULL OR ${t.resultKey} = 'tmp/zips/' || ${t.id}::text || '.zip'`,
    ),
    check(
      'zip_jobs_error_code_format',
      sql`${t.errorCode} IS NULL OR ${t.errorCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
    check(
      'zip_jobs_ready_has_result',
      sql`(${t.status} = 'ready') = (${t.resultKey} IS NOT NULL) AND (${t.status} <> 'ready' OR (${t.resultBytes} IS NOT NULL AND ${t.expiresAt} IS NOT NULL))`,
    ),
    check(
      'zip_jobs_failed_has_error',
      sql`(${t.status} = 'failed') = (${t.errorCode} IS NOT NULL)`,
    ),
    check(
      'zip_jobs_completed_iff_finished',
      sql`(${t.status} IN ('ready', 'failed')) = (${t.completedAt} IS NOT NULL)`,
    ),
    check(
      'zip_jobs_started_when_claimed',
      sql`${t.status} NOT IN ('running', 'ready') OR ${t.startedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * The files of a zip job, in archive order. `name` is the name inside the archive: safe (see
 * sanitizeOriginalName) and unique within the job ignoring case (see uniqueZipEntryNames, which
 * folds all of Unicode with toLowerCase). The database backs that up with
 * `zip_job_entries_name_folded_unique` on `lower(name COLLATE "C")`, which folds ASCII only: it
 * catches the collision that matters (IMG_0001.JPG vs img_0001.jpg), never rejects names the
 * helper produced, and behaves the same on every PostgreSQL whatever its ctype. Purging a file
 * removes its entries (ON DELETE CASCADE); `zip_jobs.file_count` lets the worker notice.
 */
export const zipJobEntries = pgTable(
  'zip_job_entries',
  {
    jobId: uuid('job_id').notNull(),
    photographerId: uuid('photographer_id').notNull(),
    /** 0-based position in the archive. */
    position: integer('position').notNull(),
    fileId: uuid('file_id').notNull(),
    name: text('name').notNull(),
  },
  (t) => [
    primaryKey({ name: 'zip_job_entries_pkey', columns: [t.jobId, t.position] }),
    unique('zip_job_entries_file_unique').on(t.jobId, t.fileId),
    uniqueIndex('zip_job_entries_name_folded_unique').on(t.jobId, driveNameKeySql(t.name)),
    foreignKey({
      name: 'zip_job_entries_job_same_photographer_fk',
      columns: [t.jobId, t.photographerId],
      foreignColumns: [zipJobs.id, zipJobs.photographerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'zip_job_entries_file_same_photographer_fk',
      columns: [t.fileId, t.photographerId],
      foreignColumns: [files.id, files.ownerId],
    }).onDelete('cascade'),
    index('zip_job_entries_file_idx').on(t.fileId, t.photographerId),
    check(
      'zip_job_entries_position_range',
      sql`${t.position} >= 0 AND ${t.position} < ${maxFiles}`,
    ),
    check(
      'zip_job_entries_name_valid',
      sql`octet_length(${t.name}) BETWEEN 1 AND 255 AND strpos(${t.name}, '/') = 0`,
    ),
  ],
);
