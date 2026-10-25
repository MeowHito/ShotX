import { type DriveFile, files, type NewDriveFile, storageUsage } from '@shotx/db';
import { derivedKey, originalKey } from '@shotx/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/db';
import { newId } from '../drive/folders';

/**
 * Inserts a ready, verified image (as the worker leaves it) and counts its bytes as used, the
 * way the worker's verify does.
 */
export async function insertReadyFile(
  db: Db,
  ownerId: string,
  values: Partial<NewDriveFile> & { name: string },
): Promise<DriveFile> {
  // uuidv7 like real rows, so id order is creation order.
  const id = await newId(db);
  const parts = { photographerId: ownerId, fileId: id };
  const sizeBytes = values.sizeBytes ?? 1000;
  const [row] = await db
    .insert(files)
    .values({
      id,
      ownerId,
      mime: 'image/jpeg',
      sizeBytes,
      s3Key: originalKey({ ...parts, originalName: 'IMG.jpg' }),
      thumbKey: derivedKey(parts, 'thumb'),
      previewKey: derivedKey(parts, 'preview'),
      webKey: derivedKey(parts, 'web'),
      status: 'ready',
      verifiedAt: new Date(),
      ...values,
    })
    .returning();
  if (row === undefined) throw new Error('no file');
  await db
    .insert(storageUsage)
    .values({ photographerId: ownerId, usedBytes: sizeBytes, reservedBytes: 0 })
    .onConflictDoUpdate({
      target: storageUsage.photographerId,
      set: { usedBytes: sql`${storageUsage.usedBytes} + ${sizeBytes}` },
    });
  return row;
}
