import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import {
  files,
  folderPath,
  folders,
  MIGRATIONS_FOLDER,
  type NewDriveFile,
  type NewFolder,
  storageUsage,
  users,
} from '@shotx/db';
import * as schema from '@shotx/db';
import { originalKey } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../db';

export interface TestDatabase {
  db: Db;
  close(): Promise<void>;
}

/** PostgreSQL 18 (WASM, in process) with ltree and every migration applied. */
export async function openTestDatabase(): Promise<TestDatabase> {
  const client = await PGlite.create({ extensions: { ltree } });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.close() };
}

export async function createPhotographer(
  db: Db,
  usage: { usedBytes?: number; reservedBytes?: number } = {},
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ role: 'photographer', cognitoPool: 'users', cognitoSub: randomUUID() })
    .returning({ id: users.id });
  const id = user!.id;
  await db.insert(storageUsage).values({
    photographerId: id,
    usedBytes: usage.usedBytes ?? 0,
    reservedBytes: usage.reservedBytes ?? 0,
  });
  return id;
}

export async function createFolder(
  db: Db,
  ownerId: string,
  options: {
    parent?: { id: string; path: string } | null;
    name?: string;
  } & Partial<NewFolder> = {},
): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const { parent, ...rest } = options;
  const path = folderPath(parent?.path ?? null, id);
  await db.insert(folders).values({
    name: `folder-${id.slice(0, 8)}`,
    ...rest,
    id,
    ownerId,
    parentId: parent?.id ?? null,
    path,
  });
  return { id, path };
}

/** A file row as `POST /uploads/init` leaves it (`uploading`, bytes reserved by the caller). */
export async function createFileRow(
  db: Db,
  ownerId: string,
  overrides: Partial<NewDriveFile> & { originalName?: string } = {},
): Promise<{ id: string; s3Key: string }> {
  const id = overrides.id ?? randomUUID();
  const { originalName = 'IMG_0001.jpg', ...rest } = overrides;
  const s3Key = originalKey({ photographerId: ownerId, fileId: id, originalName });
  await db.insert(files).values({
    name: originalName,
    mime: 'image/jpeg',
    sizeBytes: 1000,
    status: 'uploading',
    ...rest,
    id,
    ownerId,
    s3Key,
  });
  return { id, s3Key };
}

export async function usageOf(db: Db, photographerId: string) {
  const [row] = await db
    .select({ usedBytes: storageUsage.usedBytes, reservedBytes: storageUsage.reservedBytes })
    .from(storageUsage)
    .where(eq(storageUsage.photographerId, photographerId));
  return row;
}

export async function fileById(db: Db, id: string) {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  return row;
}
