import { z } from 'zod';
import { fileExtension } from '../media-types';
import { ORIGINAL_NAME_MAX_BYTES, originalNameSchema, utf8ByteLength } from '../s3-keys';

/**
 * Names of folders and files in the drive.
 *
 * Rules (the database enforces the uniqueness part with partial unique indexes, migration 0002):
 * - A name is NFC, trimmed, 1–255 UTF-8 bytes, well-formed Unicode, without `/`, `\`, control
 *   characters or bidi overrides, and not `.` or `..` ({@link driveNameSchema}).
 * - Among the live (not trashed) children of one folder, or of the drive root, of one owner, names
 *   are unique ignoring ASCII case: `IMG_0001.JPG` and `img_0001.jpg` collide, `Ä` and `ä` don't,
 *   and Thai has no case. Folders and files are separate namespaces, so a folder and a file may
 *   share a name. `failed` files don't hold their name.
 * - Only ASCII is folded because PostgreSQL's `lower()` depends on the database's ctype (RDS and
 *   PGlite differ), while `lower(name COLLATE "C")` folds exactly A–Z everywhere. The index uses
 *   that expression and {@link driveNameKey} computes the same key in TypeScript.
 *
 * The API stores names as {@link driveNameSchema} outputs them, and relies on the unique index
 * (SQLSTATE 23505) rather than a check-then-insert, which would race.
 */

// Control characters and bidi overrides/isolates (they can disguise an extension).
const FORBIDDEN_CHARS = /[\p{Cc}‪-‮⁦-⁩]/u;
const SEPARATORS = /[/\\]/;

/**
 * zod schema of a folder or file name sent by a client: NFC-normalizes and trims, then applies
 * {@link originalNameSchema} (1–255 UTF-8 bytes, no lone surrogates) and the drive rules above.
 */
export const driveNameSchema = z
  .string()
  .transform((name) => name.normalize('NFC').trim())
  .pipe(
    originalNameSchema
      .refine((name) => !SEPARATORS.test(name), { error: 'must not contain / or \\' })
      .refine((name) => !FORBIDDEN_CHARS.test(name), {
        error: 'must not contain control characters or bidi overrides',
      })
      .refine((name) => name !== '.' && name !== '..', { error: 'must not be . or ..' }),
  );

/** The key two sibling names collide on: ASCII A–Z lowercased, nothing else changed. */
export function driveNameKey(name: string): string {
  return name.replace(/[A-Z]+/g, (s) => s.toLowerCase());
}

/**
 * `name` if its key is free, otherwise the first free `stem (n).ext` (files) or `name (n)`
 * (folders) for n = 2, 3, …, shortened so it stays within 255 UTF-8 bytes. `isTaken` gets
 * {@link driveNameKey} keys. For the API when an upload asks for `onNameConflict: 'rename'` and
 * when restoring from trash into a folder that has a new item with the same name.
 *
 * Throws RangeError after 10,000 attempts.
 */
export function availableDriveName(
  name: string,
  kind: 'folder' | 'file',
  isTaken: (key: string) => boolean,
): string {
  if (!isTaken(driveNameKey(name))) return name;
  for (let n = 2; n <= 10_000; n++) {
    const candidate = numberedDriveName(name, kind, n);
    if (!isTaken(driveNameKey(candidate))) return candidate;
  }
  throw new RangeError('No free name found after 10,000 attempts');
}

/** `stem (n).ext` for files, `name (n)` for folders, within 255 UTF-8 bytes. */
export function numberedDriveName(name: string, kind: 'folder' | 'file', n: number): string {
  const ext =
    kind === 'file' && fileExtension(name) !== null ? name.slice(name.lastIndexOf('.')) : '';
  const tag = ` (${n})`;
  const budget = ORIGINAL_NAME_MAX_BYTES - utf8ByteLength(tag + ext);
  let stem = '';
  let used = 0;
  for (const ch of name.slice(0, name.length - ext.length)) {
    used += utf8ByteLength(ch);
    if (used > budget) break;
    stem += ch;
  }
  return `${stem.trimEnd() || 'file'}${tag}${ext}`;
}

/** Longest `relativePath` accepted by `POST /uploads/init`, in characters. */
export const RELATIVE_PATH_MAX_LENGTH = 4096;

/**
 * The folder part of a dropped file's relative path, `/`-separated, without the file name and
 * without leading or trailing `/`: for `Event/Day 1/IMG_0001.jpg` dropped into folder F the client
 * sends `name: "IMG_0001.jpg"`, `folderId: F`, `relativePath: "Event/Day 1"`. Parses to the list
 * of folder names (each a {@link driveNameSchema}); the API finds or creates each level under
 * `folderId` and puts the file in the last one.
 */
export const relativePathSchema = z
  .string()
  .max(RELATIVE_PATH_MAX_LENGTH)
  .transform((path) => path.split('/'))
  .pipe(z.array(driveNameSchema).min(1));
