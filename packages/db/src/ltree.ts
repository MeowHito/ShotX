import { ErrorCode } from '@shotx/shared';
import { type SQL, sql } from 'drizzle-orm';
import { folders } from './schema/drive';

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

function assertPath(label: string, path: string): void {
  if (!PATH.test(path)) {
    throw new RangeError(`${label} ${JSON.stringify(path)} is not a valid ltree path`);
  }
}

/** Number of labels, `nlevel(path)`: 1 for a folder at the drive root. */
export function folderDepth(path: string): number {
  assertPath('Path', path);
  return path.split('.').length;
}

/** `path <@ ancestor`: true when `path` is `ancestor` or below it. */
export function isPathWithin(path: string, ancestor: string): boolean {
  assertPath('Path', path);
  assertPath('Ancestor path', ancestor);
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/** Depth a new folder under `parentPath` (null: the root) would have. */
export function childFolderDepth(parentPath: string | null): number {
  return parentPath === null ? 1 : folderDepth(parentPath) + 1;
}

export interface FolderMovePlan {
  folderId: string;
  /** null moves the folder to the drive root. */
  newParentId: string | null;
  /** The folder's path before and after; every descendant's prefix changes the same way. */
  oldPath: string;
  newPath: string;
  /** True when the folder already has this parent (nothing to rewrite). */
  noop: boolean;
}

export type FolderMoveResult =
  | { ok: true; plan: FolderMovePlan }
  | { ok: false; code: typeof ErrorCode.INVALID_MOVE }
  | { ok: false; code: typeof ErrorCode.FOLDER_DEPTH_EXCEEDED; maxDepth: number };

export interface FolderMoveInput {
  folder: { id: string; path: string; parentId: string | null };
  /** The target parent as read from the database (live, same owner), or null for the root. */
  newParent: { id: string; path: string } | null;
  /** `max(nlevel(path))` over the folder's subtree (trashed descendants included). */
  subtreeMaxDepth: number;
  /** DRIVE_MAX_FOLDER_DEPTH. */
  maxDepth: number;
}

/**
 * Plans moving a folder and its subtree. Rejects moving a folder into itself or one of its
 * descendants (INVALID_MOVE), and moves that would make the subtree deeper than `maxDepth`
 * (FOLDER_DEPTH_EXCEEDED). Paths must be the ones read from the database, never sent by a client.
 * Apply the plan with {@link folderSubtreeMoveSql} inside the transaction that read the rows
 * (lock the folder and the new parent FOR UPDATE first).
 */
export function planFolderMove(input: FolderMoveInput): FolderMoveResult {
  const { folder, newParent } = input;
  const label = folderPathLabel(folder.id);
  assertPath('Folder path', folder.path);
  if (folder.path.split('.').at(-1) !== label || folderDepth(folder.path) > input.subtreeMaxDepth) {
    throw new RangeError('Folder path and subtree depth do not belong to this folder');
  }
  if (
    newParent !== null &&
    (newParent.id === folder.id || isPathWithin(newParent.path, folder.path))
  ) {
    return { ok: false, code: ErrorCode.INVALID_MOVE };
  }
  const newPath = folderPath(newParent?.path ?? null, folder.id);
  const deepest = input.subtreeMaxDepth - folderDepth(folder.path) + folderDepth(newPath);
  if (deepest > input.maxDepth) {
    return { ok: false, code: ErrorCode.FOLDER_DEPTH_EXCEEDED, maxDepth: input.maxDepth };
  }
  const newParentId = newParent?.id ?? null;
  return {
    ok: true,
    plan: {
      folderId: folder.id,
      newParentId,
      oldPath: folder.path,
      newPath,
      noop: newParentId === folder.parentId && newPath === folder.path,
    },
  };
}

/** The path a folder in the moved subtree gets: the plan's prefix swapped. */
export function rewriteFolderPath(path: string, plan: FolderMovePlan): string {
  if (!isPathWithin(path, plan.oldPath)) {
    throw new RangeError(`Path ${JSON.stringify(path)} is not in the moved subtree`);
  }
  return plan.newPath + path.slice(plan.oldPath.length);
}

/**
 * The UPDATE that applies a move: rewrites the path of every folder in the subtree (live and
 * trashed) and sets the moved folder's parent, in one statement. Files need no change: they
 * reference their folder by id. Returns the number of rows changed via the driver's row count.
 *
 * `subpath(path, nlevel(old) - 1)` keeps the moved folder's own label, so the statement is valid
 * for the folder itself too (`subpath(p, nlevel(p))` would be an error).
 */
export function folderSubtreeMoveSql(ownerId: string, plan: FolderMovePlan): SQL {
  const keep = folderDepth(plan.oldPath) - 1;
  const parentPath = plan.newPath.includes('.')
    ? plan.newPath.slice(0, plan.newPath.lastIndexOf('.'))
    : null;
  const newPathExpr =
    parentPath === null
      ? sql`subpath(${folders.path}, ${keep})`
      : sql`${parentPath}::ltree || subpath(${folders.path}, ${keep})`;
  return sql`UPDATE ${folders}
    SET path = ${newPathExpr},
        parent_id = CASE WHEN ${folders.id} = ${plan.folderId}::uuid THEN ${plan.newParentId}::uuid ELSE ${folders.parentId} END
    WHERE ${folders.ownerId} = ${ownerId}::uuid AND ${folders.path} <@ ${plan.oldPath}::ltree`;
}
