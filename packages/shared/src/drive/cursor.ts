import { z } from 'zod';
import { CURSOR_MAX_LENGTH, decodeOpaqueCursor, encodeOpaqueCursor } from '../cursor-codec';

/**
 * Keyset pagination of drive listings. Cursors are opaque to clients: the web app passes
 * `nextCursor` back unchanged and never builds or parses one.
 *
 * `GET /drive/folders/:id/children` lists folders first, then files, each in the requested sort:
 *
 *   sort=name       ORDER BY lower(name COLLATE "C") {order}, id {order}   (driveNameKey)
 *   sort=createdAt  ORDER BY id {order}   (ids are uuidv7, so id order is creation order)
 *
 * A page reads folders after the cursor (while `phase` is `folders`) and, if fewer than `limit`
 * remain, continues with files from the start; `nextCursor` encodes the last item returned, or is
 * null when nothing follows. `GET /drive/trash` lists folders and files in one sequence
 * (UNION ALL), ORDER BY deleted_at DESC, id DESC, with cursors of `phase: 'trash'`,
 * `sort: 'createdAt'`, `order: 'desc'` and `key` = the last item's `deleted_at::text` (full
 * microsecond precision; a JavaScript Date would truncate it and break the keyset).
 *
 * A cursor is only valid with the sort and order it was made for; a mismatch, a cursor from
 * another listing or a malformed one is VALIDATION_FAILED.
 */
export const DRIVE_SORTS = ['name', 'createdAt'] as const;
export type DriveSort = (typeof DRIVE_SORTS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const driveCursorSchema = z.object({
  v: z.literal(1),
  sort: z.enum(DRIVE_SORTS),
  order: z.enum(SORT_ORDERS),
  phase: z.enum(['folders', 'files', 'trash']),
  /** Sort key of the last item: its driveNameKey for `name`, deleted_at text for trash. */
  key: z.string().max(1024).nullable(),
  /** Kind of the last item (trash lists both kinds in one sequence). */
  kind: z.enum(['folder', 'file']),
  id: z.uuid(),
});
export type DriveCursor = z.output<typeof driveCursorSchema>;

/** Largest encoded cursor accepted in a query string. */
export const DRIVE_CURSOR_MAX_LENGTH = CURSOR_MAX_LENGTH;

/** base64url(JSON) of a validated cursor. */
export function encodeDriveCursor(cursor: DriveCursor): string {
  return encodeOpaqueCursor(driveCursorSchema, cursor);
}

/** The cursor, or null when `text` is not a cursor this module made. Never throws. */
export function decodeDriveCursor(text: string): DriveCursor | null {
  return decodeOpaqueCursor(driveCursorSchema, text);
}
