/** ltree label characters this platform uses. (PostgreSQL 16+ also allows `-`; we don't.) */
const LABEL = /^[A-Za-z0-9_]{1,1000}$/;
const PATH = /^[A-Za-z0-9_]{1,1000}(\.[A-Za-z0-9_]{1,1000})*$/;

/** The ltree label of a folder: its id with `-` replaced by `_`. */
export function folderPathLabel(folderId: string): string {
  const label = folderId.replace(/-/g, '_');
  if (!LABEL.test(label)) {
    throw new RangeError(`Folder id ${JSON.stringify(folderId)} does not make a valid ltree label`);
  }
  return label;
}

/**
 * The `path` of a folder: its parent's path plus its own label, or just its label at the root.
 * Pass the parent's path as read from the database, never one sent by a client.
 */
export function folderPath(parentPath: string | null, folderId: string): string {
  const label = folderPathLabel(folderId);
  if (parentPath === null) return label;
  if (!PATH.test(parentPath)) {
    throw new RangeError(`Parent path ${JSON.stringify(parentPath)} is not a valid ltree path`);
  }
  return `${parentPath}.${label}`;
}
