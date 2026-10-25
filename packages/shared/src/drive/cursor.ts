import { z } from 'zod';

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
export const DRIVE_CURSOR_MAX_LENGTH = 2048;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** base64url(JSON) of a validated cursor. */
export function encodeDriveCursor(cursor: DriveCursor): string {
  const valid = driveCursorSchema.parse(cursor);
  return toBase64Url(new TextEncoder().encode(JSON.stringify(valid)));
}

/** The cursor, or null when `text` is not a cursor this module made. Never throws. */
export function decodeDriveCursor(text: string): DriveCursor | null {
  if (
    text.length === 0 ||
    text.length > DRIVE_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(text)
  ) {
    return null;
  }
  try {
    const json: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(text)),
    );
    const result = driveCursorSchema.safeParse(json);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
