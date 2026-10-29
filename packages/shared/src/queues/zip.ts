import { z } from 'zod';
import { ZIP_MAX_FILES_LIMIT } from '../config/share';
import { fileExtension } from '../media-types';
import {
  isSafeOriginalName,
  ORIGINAL_NAME_MAX_BYTES,
  parseS3Key,
  utf8ByteLength,
} from '../s3-keys';

/**
 * Body of a `zip` queue message: only the job id, so a message stays far below SQS's 256 KiB
 * limit however many files the job has.
 *
 * `POST /s/:token/downloads` checks the share, its scope, the face_only grant and the download
 * size, then inserts a `zip_jobs` row (status `queued`) with one `zip_job_entries` row per file in
 * the same transaction, and only then sends this message. The worker loads the job and its
 * entries, resolves each file to its S3 key (`files.s3_key` for `original`, `files.web_key` for
 * `web`), checks the result with {@link parseZipEntries}, and streams the objects into
 * `tmp/zips/{jobId}.zip` with store (no compression). SQS delivers at least once, so the worker
 * skips jobs that are no longer `queued` (or whose `running` attempt is still alive).
 */
export const zipQueueMessageSchema = z.object({
  type: z.literal('zip.create'),
  jobId: z.uuid(),
});
export type ZipQueueMessage = z.output<typeof zipQueueMessageSchema>;

/** Longest path of one archive entry, in UTF-8 bytes (folder segments, `/` and the file name). */
export const ZIP_ENTRY_PATH_MAX_BYTES = 1024;

/** Most `/`-separated segments of one entry path (folders below the zipped folder + file). */
export const ZIP_ENTRY_PATH_MAX_SEGMENTS = 101;

/**
 * True for a safe path inside an archive: 1 to ZIP_ENTRY_PATH_MAX_SEGMENTS segments joined by
 * `/`, each a safe name (isSafeOriginalName: no `..`, no leading dot, no separators or control
 * characters), at most ZIP_ENTRY_PATH_MAX_BYTES. No leading or trailing `/`, no empty segment,
 * so extraction can never leave the target directory. Share zips use single names; owner folder
 * zips (Wave 7) keep the folder structure below the zipped folder (`Day 1/IMG_0001.jpg`).
 */
export function isSafeZipEntryPath(path: string): boolean {
  if (utf8ByteLength(path) > ZIP_ENTRY_PATH_MAX_BYTES) return false;
  const segments = path.split('/');
  return (
    segments.length >= 1 &&
    segments.length <= ZIP_ENTRY_PATH_MAX_SEGMENTS &&
    segments.every((segment) => isSafeOriginalName(segment))
  );
}

/** One object of a zip job, resolved by the worker from a `zip_job_entries` row. */
export const zipEntrySchema = z.object({
  fileId: z.uuid(),
  /** The object to add: the original, or a derivative such as web.jpg. */
  key: z.string().min(1),
  /**
   * Path inside the archive: a safe name, or for owner folder zips a safe path
   * (isSafeZipEntryPath). Unique within the job ignoring case.
   */
  name: z.string().refine(isSafeZipEntryPath, {
    error: 'must be a safe file name or path (see sanitizeOriginalName, isSafeZipEntryPath)',
  }),
  bytes: z.number().int().nonnegative(),
});
export type ZipEntry = z.output<typeof zipEntrySchema>;

/**
 * The key two archive entry names collide on. Names are compared ignoring case because archives
 * are often extracted on case-insensitive file systems.
 */
export function zipEntryNameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The entries of one zip job, as the worker rebuilds them before streaming. Every key must be an
 * `originals/` or `derived/` key of `photographerId` and of its entry's file, and names must be
 * unique ignoring case (see {@link zipEntryNameKey}). ZIP_MAX_FILES and ZIP_MAX_BYTES are
 * enforced by the API; this schema only caps entries at the largest allowed ZIP_MAX_FILES.
 */
export const zipEntriesSchema = z
  .object({
    photographerId: z.uuid(),
    entries: z.array(zipEntrySchema).min(1).max(ZIP_MAX_FILES_LIMIT),
  })
  .superRefine((job, ctx) => {
    const names = new Set<string>();
    job.entries.forEach((entry, i) => {
      const parsed = parseS3Key(entry.key);
      if (
        parsed === null ||
        (parsed.kind !== 'original' && parsed.kind !== 'derived') ||
        parsed.photographerId !== job.photographerId ||
        parsed.fileId !== entry.fileId
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'key'],
          message: "must be an originals/ or derived/ key of the entry's file and photographer",
        });
      }
      const folded = zipEntryNameKey(entry.name);
      if (names.has(folded)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'name'],
          message: 'must be unique within the job (ignoring case)',
        });
      }
      names.add(folded);
    });
  });
export type ZipEntries = z.output<typeof zipEntriesSchema>;

/** Zip job entries that break the rules of {@link zipEntriesSchema}. */
export class ZipEntriesError extends Error {
  override readonly name = 'ZipEntriesError';
}

/**
 * Validates the entries the worker rebuilt for one job. Throws ZipEntriesError, whose message
 * names the offending entries by index (never the file names).
 */
export function parseZipEntries(job: z.input<typeof zipEntriesSchema>): ZipEntries {
  const result = zipEntriesSchema.safeParse(job);
  if (!result.success) {
    const where = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ZipEntriesError(`Invalid zip entries:\n${where.join('\n')}`);
  }
  return result.data;
}

/**
 * Archive names for `names` in order, unique ignoring case: the first occurrence keeps its name,
 * later ones get ` (2)`, ` (3)`, … before the extension. Every input must already be safe (see
 * sanitizeOriginalName); outputs are safe and at most 255 UTF-8 bytes. For the API, before it
 * inserts `zip_job_entries`.
 */
export function uniqueZipEntryNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    if (!isSafeOriginalName(name)) {
      throw new RangeError('Zip entry names must be sanitized with sanitizeOriginalName first');
    }
    let candidate = name;
    for (let n = 2; taken.has(zipEntryNameKey(candidate)); n++) {
      candidate = numberedName(name, n);
    }
    taken.add(zipEntryNameKey(candidate));
    return candidate;
  });
}

/**
 * Like {@link uniqueZipEntryNames} for archive paths (owner folder zips): each input is a list of
 * segments, the folders below the zipped folder and then the file name, every segment already
 * sanitized (sanitizeOriginalName). Outputs are `/`-joined safe paths (isSafeZipEntryPath), in
 * input order.
 *
 * Every directory prefix of every input (`Day 1`, `Day 1/Run`) counts as taken before any file is
 * named, so a file never shares a path with a directory whatever the order of the inputs (a file
 * `IMG.jpg` next to a folder `IMG.jpg` becomes `IMG (2).jpg`; an archive with both `IMG.jpg` and
 * `IMG.jpg/a.jpg` can't be extracted). Paths are compared ignoring case (zipEntryNameKey), as
 * entry names are: collisions number the file name (` (2)`, …), and folder segments are never
 * changed (folders whose names differ only in case end up as one directory when extracted, which
 * keeps every file because file paths are unique). Throws RangeError for an unsafe segment or a
 * path over the limits.
 */
export function uniqueZipEntryPaths(paths: readonly (readonly string[])[]): string[] {
  for (const segments of paths) {
    if (segments.length === 0 || !segments.every((s) => isSafeOriginalName(s))) {
      throw new RangeError(
        'Zip entry path segments must be sanitized with sanitizeOriginalName first',
      );
    }
  }
  const taken = new Set<string>();
  for (const segments of paths) {
    for (let depth = 1; depth < segments.length; depth++) {
      taken.add(zipEntryNameKey(segments.slice(0, depth).join('/')));
    }
  }
  return paths.map((segments) => {
    const fileName = segments.at(-1) ?? '';
    const dir = segments.slice(0, -1).join('/');
    const join = (name: string) => (dir === '' ? name : `${dir}/${name}`);
    let candidate = join(fileName);
    for (let n = 2; taken.has(zipEntryNameKey(candidate)); n++) {
      candidate = join(numberedName(fileName, n));
    }
    if (!isSafeZipEntryPath(candidate)) {
      throw new RangeError('Zip entry path is too long or too deep');
    }
    taken.add(zipEntryNameKey(candidate));
    return candidate;
  });
}

function numberedName(name: string, n: number): string {
  const ext = fileExtension(name) === null ? '' : name.slice(name.lastIndexOf('.'));
  const tag = ` (${n})`;
  // Shorten the stem, never the tag or the extension, to stay within the byte limit.
  const budget = ORIGINAL_NAME_MAX_BYTES - utf8ByteLength(tag + ext);
  let stem = '';
  let used = 0;
  for (const ch of name.slice(0, name.length - ext.length)) {
    used += utf8ByteLength(ch);
    if (used > budget) break;
    stem += ch;
  }
  return `${stem.replace(/[.\s]+$/u, '') || 'file'}${tag}${ext}`;
}
