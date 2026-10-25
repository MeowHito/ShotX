import { z } from 'zod';
import { ZIP_MAX_FILES_LIMIT } from '../config/share';
import { isSafeOriginalName, parseS3Key } from '../s3-keys';

export const zipEntrySchema = z.object({
  fileId: z.uuid(),
  /** The object to add: the original, or a derivative such as web.jpg. */
  key: z.string().min(1),
  /** Name inside the archive. Safe (see isSafeOriginalName) and unique within the job. */
  name: z.string().refine(isSafeOriginalName, {
    error: 'must be a safe file name (see sanitizeOriginalName)',
  }),
  bytes: z.number().int().nonnegative(),
});
export type ZipEntry = z.output<typeof zipEntrySchema>;

/**
 * Body of a `zip` queue message. The API has already checked the share, its scope, the
 * face_only grant and the download size, and resolved each file to an S3 key; the worker streams
 * the objects into `tmp/zips/{jobId}.zip` with store (no compression). Every key must belong to
 * `photographerId` and to its entry's file. The API enforces ZIP_MAX_FILES and ZIP_MAX_BYTES;
 * this schema only caps entries at the largest allowed ZIP_MAX_FILES.
 */
export const zipQueueMessageSchema = z
  .object({
    type: z.literal('zip.create'),
    jobId: z.uuid(),
    shareId: z.uuid(),
    photographerId: z.uuid(),
    entries: z.array(zipEntrySchema).min(1).max(ZIP_MAX_FILES_LIMIT),
  })
  .superRefine((message, ctx) => {
    const names = new Set<string>();
    message.entries.forEach((entry, i) => {
      const parsed = parseS3Key(entry.key);
      if (
        parsed === null ||
        (parsed.kind !== 'original' && parsed.kind !== 'derived') ||
        parsed.photographerId !== message.photographerId ||
        parsed.fileId !== entry.fileId
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'key'],
          message: "must be an originals/ or derived/ key of the entry's file and photographer",
        });
      }
      // Case-insensitive: archives are often extracted on case-insensitive file systems.
      const folded = entry.name.toLowerCase();
      if (names.has(folded)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'name'],
          message: 'must be unique within the job (ignoring case)',
        });
      }
      names.add(folded);
    });
  });
export type ZipQueueMessage = z.output<typeof zipQueueMessageSchema>;
