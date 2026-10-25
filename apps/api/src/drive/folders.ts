import { folderPath, folders, type Folder } from '@shotx/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Queryable, rows } from '../db/db';

export type LockMode = 'update' | 'share' | null;

/** A live (not trashed) folder of the owner, optionally locked; null for anything else. */
export async function liveFolder(
  q: Queryable,
  ownerId: string,
  folderId: string,
  lock: LockMode = null,
): Promise<Folder | null> {
  const query = q
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.ownerId, ownerId), isNull(folders.deletedAt)));
  const [row] = lock === null ? await query : await query.for(lock);
  return row ?? null;
}

/** A new uuidv7 from PostgreSQL (the folder path needs the id before the insert). */
export async function newId(q: Queryable): Promise<string> {
  const [row] = await rows<{ id: string }>(q, sql`SELECT uuidv7()::text AS id`);
  if (row === undefined) throw new Error('uuidv7() returned no row');
  return row.id;
}

/** Inserts a live folder under `parent` (null: the root). Unique violations propagate. */
export async function insertFolder(
  q: Queryable,
  input: { ownerId: string; parent: Pick<Folder, 'id' | 'path'> | null; name: string },
): Promise<Folder> {
  const id = await newId(q);
  const [row] = await q
    .insert(folders)
    .values({
      id,
      ownerId: input.ownerId,
      parentId: input.parent?.id ?? null,
      name: input.name,
      path: folderPath(input.parent?.path ?? null, id),
    })
    .returning();
  if (row === undefined) throw new Error('Folder insert returned no row');
  return row;
}

/** `max(nlevel(path))` over a folder's subtree, trashed descendants included. */
export async function subtreeMaxDepth(
  q: Queryable,
  ownerId: string,
  path: string,
): Promise<number> {
  const [row] = await rows<{ depth: number | string | null }>(
    q,
    sql`SELECT max(nlevel(${folders.path})) AS depth FROM ${folders}
        WHERE ${folders.ownerId} = ${ownerId}::uuid AND ${folders.path} <@ ${path}::ltree`,
  );
  return Number(row?.depth ?? 0);
}

/** Folder ids of a path, top-down (labels are ids with `-` replaced by `_`). */
export function pathFolderIds(path: string): string[] {
  return path.split('.').map((label) => label.replace(/_/g, '-'));
}

/** The folders above `folder`, from the top-level one down to its parent. */
export async function ancestorsOf(
  q: Queryable,
  ownerId: string,
  folder: Pick<Folder, 'path'>,
): Promise<{ id: string; name: string }[]> {
  const ids = pathFolderIds(folder.path).slice(0, -1);
  if (ids.length === 0) return [];
  const found = await q
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, ids)));
  const byId = new Map(found.map((f) => [f.id, f]));
  return ids.flatMap((id) => {
    const f = byId.get(id);
    return f === undefined ? [] : [f];
  });
}
