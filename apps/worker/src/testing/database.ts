import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  designAssets,
  files,
  folderPath,
  folders,
  MIGRATIONS_FOLDER,
  type NewDriveFile,
  type NewFolder,
  shareDesigns,
  storageUsage,
  users,
} from '@shotx/db';
import * as schema from '@shotx/db';
import type { PgPoolLike } from '@shotx/face';
import { blankDesignDoc, type DesignDoc, designAssetKey, originalKey } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../db';

export interface TestDatabase {
  db: Db;
  /** The same database as node-postgres-like queries (the self-hosted face vector store). */
  pool: PgPoolLike;
  close(): Promise<void>;
}

/**
 * PostgreSQL 18 (WASM, in process) with ltree, pg_trgm (migration 0008), pgvector (migration 0010)
 * and every migration applied.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const queryable = {
    query: async (text: string, values?: unknown[]) => ({
      rows: (await client.query(text, values)).rows,
    }),
  };
  // PGlite has one connection: `connect` hands out the same one (queries run in order).
  const pool: PgPoolLike = {
    ...queryable,
    connect: () => Promise.resolve({ ...queryable, release: () => undefined }),
  };
  return { db: db as unknown as Db, pool, close: () => client.close() };
}

export async function createPhotographer(
  db: Db,
  usage: { usedBytes?: number; reservedBytes?: number } = {},
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ role: 'photographer', authPool: 'users', authSubject: `local:${randomUUID()}` })
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
  // ADR 0011 decision 1 (migration 0012): face indexing is on by default, expiring creation + 90
  // days (the database defaults); pass `faceIndexEnabled: false` for a photographer's opt-out.
  // face_index_informed_at is no longer written.
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

/** Part size of the multipart plans test uploads were "created" with (16 MiB, the default). */
export const TEST_UPLOAD_PART_BYTES = 16 * 1024 * 1024;

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
    // files_upload_part_bytes_valid: an open multipart upload records its part size.
    ...(rest.uploadId != null ? { uploadPartBytes: TEST_UPLOAD_PART_BYTES } : {}),
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

/**
 * A design image row (ADR 0013). Default: as `POST /designs/assets/:id/complete` leaves it
 * (`processing`, `queued_at` now, bytes reserved by the caller), PNG of 1000 bytes.
 */
export async function createDesignAsset(
  db: Db,
  ownerId: string,
  overrides: Partial<typeof designAssets.$inferInsert> = {},
): Promise<{ id: string; originalKey: string; webKey: string }> {
  const id = overrides.id ?? randomUUID();
  const status = overrides.status ?? 'processing';
  await db.insert(designAssets).values({
    mime: 'image/png',
    sizeBytes: 1000,
    queuedAt: new Date(),
    ...(status === 'uploading' ? { uploadExpiresAt: new Date(Date.now() + 3_600_000) } : {}),
    ...overrides,
    status,
    id,
    ownerId,
  });
  const parts = { photographerId: ownerId, assetId: id };
  return {
    id,
    originalKey: designAssetKey(parts, 'original'),
    webKey: designAssetKey(parts, 'web'),
  };
}

export async function designAssetById(db: Db, id: string) {
  const [row] = await db.select().from(designAssets).where(eq(designAssets.id, id));
  return row;
}

/**
 * A blank design whose background is `backgroundAssetId` (if given) with one image element per
 * id in `imageAssetIds`. `doc` replaces the document (any JSON object; the database only checks
 * that it is one).
 */
export async function createDesign(
  db: Db,
  ownerId: string,
  options: { backgroundAssetId?: string; imageAssetIds?: string[]; doc?: unknown } = {},
): Promise<string> {
  const base = blankDesignDoc();
  const doc: DesignDoc = {
    ...base,
    background:
      options.backgroundAssetId === undefined
        ? base.background
        : { type: 'image', assetId: options.backgroundAssetId, blur: 0, dim: 0, color: '#000000' },
    elements: [
      ...base.elements,
      ...(options.imageAssetIds ?? []).map((assetId, i) => ({
        id: `img-${i}`,
        type: 'image' as const,
        assetId,
        x: 10,
        y: 10,
        w: 100,
        h: 100,
        rotation: 0,
        opacity: 1,
        locked: false,
        hidden: false,
        fit: 'contain' as const,
        radius: 0,
        flipX: false,
      })),
    ],
  };
  const [row] = await db
    .insert(shareDesigns)
    .values({
      ownerId,
      name: `design-${randomUUID().slice(0, 8)}`,
      doc: (options.doc ?? doc) as DesignDoc,
    })
    .returning({ id: shareDesigns.id });
  return row!.id;
}
