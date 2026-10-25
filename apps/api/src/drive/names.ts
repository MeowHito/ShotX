import { driveNameKeySql, files, folders } from '@shotx/db';
import { availableDriveName, driveNameKey, fileExtension } from '@shotx/shared';
import { and, eq, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { isUniqueViolation, type Queryable, type Tx } from '../db/db';

/** Escapes `\`, `%` and `_` for LIKE (default escape character `\`). */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `parent_id = $id`, or `IS NULL` for the root. */
export function folderParentIs(parentId: string | null): SQL {
  return parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId);
}

export function fileFolderIs(folderId: string | null): SQL {
  return folderId === null ? isNull(files.folderId) : eq(files.folderId, folderId);
}

/**
 * Name keys of live siblings that `name` or its numbered variants (`name (n)`, `stem (n).ext`)
 * could collide with, for availableDriveName. Long names whose numbered variants are shortened
 * may not all be found; inserts still rely on the unique index and retry ({@link withFreeName}).
 */
export async function takenNameKeys(
  q: Queryable,
  ownerId: string,
  kind: 'folder' | 'file',
  parentId: string | null,
  name: string,
): Promise<Set<string>> {
  const key = driveNameKey(name);
  const ext =
    kind === 'file' && fileExtension(name) !== null ? key.slice(key.lastIndexOf('.')) : '';
  const stem = key.slice(0, key.length - ext.length);
  const pattern = `${likeEscape(stem)} (%`;
  if (kind === 'folder') {
    const nameKey = driveNameKeySql(folders.name);
    const found = await q
      .select({ key: sql<string>`${nameKey}` })
      .from(folders)
      .where(
        and(
          eq(folders.ownerId, ownerId),
          folderParentIs(parentId),
          isNull(folders.deletedAt),
          or(sql`${nameKey} = ${key}`, sql`${nameKey} LIKE ${pattern}`),
        ),
      );
    return new Set(found.map((r) => r.key));
  }
  const nameKey = driveNameKeySql(files.name);
  const found = await q
    .select({ key: sql<string>`${nameKey}` })
    .from(files)
    .where(
      and(
        eq(files.ownerId, ownerId),
        fileFolderIs(parentId),
        isNull(files.deletedAt),
        ne(files.status, 'failed'),
        or(sql`${nameKey} = ${key}`, sql`${nameKey} LIKE ${pattern}`),
      ),
    );
  return new Set(found.map((r) => r.key));
}

/** Upper bound on insert attempts when racing other writers for a free name. */
const NAME_ATTEMPTS = 25;

/**
 * Runs `write` with the first free variant of `name` inside a savepoint; when the unique index
 * rejects it (another request took the name meanwhile), marks it taken and tries the next one.
 */
export async function withFreeName<T>(
  tx: Tx,
  input: { ownerId: string; kind: 'folder' | 'file'; parentId: string | null; name: string },
  write: (sp: Tx, name: string) => Promise<T>,
): Promise<T> {
  const taken = await takenNameKeys(tx, input.ownerId, input.kind, input.parentId, input.name);
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const candidate = availableDriveName(input.name, input.kind, (k) => taken.has(k));
    try {
      return await tx.transaction((sp) => write(sp, candidate));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      taken.add(driveNameKey(candidate));
    }
  }
  throw new Error('Could not find a free name');
}
