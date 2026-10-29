import { z } from 'zod';
import { decodeS3EventKey, parseS3Key } from '../s3-keys';

/**
 * The message S3 sends once when a bucket notification is configured. It has no Records; the
 * worker deletes it without doing anything.
 */
export const s3TestEventSchema = z.object({
  Service: z.literal('Amazon S3'),
  Event: z.literal('s3:TestEvent'),
  Time: z.string(),
  Bucket: z.string().min(1),
  RequestId: z.string().optional(),
  HostId: z.string().optional(),
});
export type S3TestEvent = z.output<typeof s3TestEventSchema>;

/**
 * One record of an S3 ObjectCreated event notification (event version 2.x) as S3 delivers it to
 * SQS. `s3.object.key` is URL-encoded (a space is `+`); decode it with `decodeS3EventKey`, or use
 * `createdObjects`, which does. Unknown fields are dropped.
 */
export const s3ObjectCreatedRecordSchema = z.object({
  eventVersion: z.string().regex(/^2\.\d+$/),
  eventSource: z.literal('aws:s3'),
  awsRegion: z.string().min(1),
  eventTime: z.iso.datetime({ offset: true }),
  /** e.g. ObjectCreated:CompleteMultipartUpload, ObjectCreated:Put. */
  eventName: z.string().regex(/^ObjectCreated:[A-Za-z]+$/),
  userIdentity: z.object({ principalId: z.string() }).optional(),
  requestParameters: z.object({ sourceIPAddress: z.string() }).optional(),
  responseElements: z.record(z.string(), z.string()).optional(),
  s3: z.object({
    s3SchemaVersion: z.string(),
    configurationId: z.string().optional(),
    bucket: z.object({
      name: z.string().min(1),
      arn: z.string().optional(),
      ownerIdentity: z.object({ principalId: z.string() }).optional(),
    }),
    object: z.object({
      key: z
        .string()
        .min(1)
        .refine(
          (key) => {
            try {
              decodeS3EventKey(key);
              return true;
            } catch {
              return false;
            }
          },
          { error: 'must be valid URL encoding' },
        ),
      size: z.number().int().nonnegative(),
      eTag: z.string().optional(),
      versionId: z.string().optional(),
      /** Orders events for the same key; compare as hex strings of equal length. */
      sequencer: z.string().optional(),
    }),
  }),
});
export type S3ObjectCreatedRecord = z.output<typeof s3ObjectCreatedRecordSchema>;

export const s3EventNotificationSchema = z.object({
  Records: z.array(s3ObjectCreatedRecordSchema).min(1),
});
export type S3EventNotification = z.output<typeof s3EventNotificationSchema>;

/**
 * "This original is complete; process it" (ADR 0008 section 2), for storage without bucket
 * notifications (R2). Sent by the API after `POST /uploads/:id/complete` commits (an enqueue
 * failure does not fail the request) and by `media.sweep` for rows whose message was lost. Works
 * on both queue backends. `key` is the file's `s3_key`, built with `originalKey` and checked
 * here with `parseS3Key`: it must be an `originals/` key of exactly this photographer and file.
 * The bucket is implicit (the worker's MEDIA_BUCKET). The worker handles it exactly like an S3
 * ObjectCreated record for the same key (see createdOriginals), so it is idempotent and a
 * duplicate of an S3 event is harmless.
 */
export const originalCompletedMessageSchema = z
  .object({
    kind: z.literal('original.completed'),
    fileId: z.uuid(),
    photographerId: z.uuid(),
    key: z.string().min(1).max(2048),
  })
  .refine(
    (m) => {
      const parsed = parseS3Key(m.key);
      return (
        parsed?.kind === 'original' &&
        parsed.fileId === m.fileId &&
        parsed.photographerId === m.photographerId
      );
    },
    { error: "key must be the file's originals/ key (originalKey)", path: ['key'] },
  );
export type OriginalCompletedMessage = z.output<typeof originalCompletedMessageSchema>;

/**
 * "Copy this file's objects" (Wave 7, `POST /drive/files/:id/copy`). The API has already, in one
 * transaction, reserved the bytes and inserted the copy's `files` row (`processing`, a new
 * `originals/` key built with originalKey, `copied_from_file_id = sourceFileId`, the source's
 * metadata, no derivative keys, `verified_at` null). The worker copies the objects server-side
 * (CopyObject, or UploadPartCopy above 5 GiB; bytes never pass through the API or the worker's
 * disk): the source's original to the copy's `s3_key`, and each derivative the source has to
 * derivedKey(copy, variant). Then, as for an upload, it checks the copy with HeadObject (size =
 * `size_bytes`), sets `verified_at` and the derivative keys, moves the bytes from reserved to
 * used, marks the row `ready`, and sends `index.file` (with the outbox mark) when a face index
 * covers the copy's folder. Faces are never copied: the copy is indexed like any new photo.
 *
 * PDPA (migration 0009): the API copies the source's `faces_withheld_at` onto the copy row. Before
 * it marks the copy `ready`, the worker re-checks the source and withholds the copy
 * (`faces_withheld_at = now()`, no `index.file`) when the source has been withheld since (a
 * deletion completed after the copy was requested) or has a deletion pending (`faces` rows with
 * `deletion_id IS NOT NULL`). A withheld copy is never indexed.
 *
 * Idempotent: a verified or `ready` copy is a no-op; a re-run overwrites the same keys. If the
 * source is gone (purged), not `ready`, or of another owner, the worker deletes whatever it
 * copied, marks the copy `failed` and releases the reservation. media.sweep re-sends this message
 * (not `original.completed`) for `processing` rows with `copied_from_file_id` set.
 */
export const fileCopyMessageSchema = z
  .object({
    kind: z.literal('file.copy'),
    fileId: z.uuid(),
    sourceFileId: z.uuid(),
    photographerId: z.uuid(),
  })
  .refine((m) => m.fileId !== m.sourceFileId, {
    error: 'fileId and sourceFileId must differ',
    path: ['sourceFileId'],
  });
export type FileCopyMessage = z.output<typeof fileCopyMessageSchema>;

/**
 * Body of a `media` queue message: an `original.completed` message (API and media.sweep), a
 * `file.copy` message (Wave 7), or what S3 bucket notifications send (AWS stacks, kept until
 * infra/ is removed).
 */
export const mediaQueueMessageSchema = z.union([
  originalCompletedMessageSchema,
  fileCopyMessageSchema,
  s3EventNotificationSchema,
  s3TestEventSchema,
]);
export type MediaQueueMessage = z.output<typeof mediaQueueMessageSchema>;

export function isFileCopy(message: MediaQueueMessage): message is FileCopyMessage {
  return 'kind' in message && message.kind === 'file.copy';
}

export function isS3TestEvent(message: MediaQueueMessage): message is S3TestEvent {
  return 'Event' in message;
}

export function isOriginalCompleted(
  message: MediaQueueMessage,
): message is OriginalCompletedMessage {
  return 'kind' in message && message.kind === 'original.completed';
}

/** The `original.completed` message of a file, validated. Throws RangeError for a foreign key. */
export function originalCompletedMessage(input: {
  fileId: string;
  photographerId: string;
  key: string;
}): OriginalCompletedMessage {
  const result = originalCompletedMessageSchema.safeParse({ kind: 'original.completed', ...input });
  if (!result.success) throw new RangeError('Not an originals/ key of this file');
  return result.data;
}

export interface CreatedObject {
  bucket: string;
  /** Decoded key. */
  key: string;
  size: number;
  eTag: string | undefined;
  sequencer: string | undefined;
  eventName: string;
  eventTime: string;
}

/**
 * The objects an S3 event reports as created, keys decoded. Empty for a TestEvent. Throws
 * RangeError for an `original.completed` message, which reports no S3 object (no bucket, size or
 * event time): use {@link mediaOriginals}, which handles every variant. Throwing, not returning
 * nothing, so a consumer that predates the variant fails the job instead of dropping it.
 */
export function createdObjects(message: MediaQueueMessage): CreatedObject[] {
  if (isOriginalCompleted(message)) {
    throw new RangeError('original.completed carries no S3 event records; use mediaOriginals');
  }
  if (isFileCopy(message)) {
    throw new RangeError('file.copy carries no S3 event records; handle it with isFileCopy');
  }
  if (isS3TestEvent(message)) return [];
  return message.Records.map((r) => ({
    bucket: r.s3.bucket.name,
    key: decodeS3EventKey(r.s3.object.key),
    size: r.s3.object.size,
    eTag: r.s3.object.eTag,
    sequencer: r.s3.object.sequencer,
    eventName: r.eventName,
    eventTime: r.eventTime,
  }));
}

/** A created object whose key is an `originals/` key built by `originalKey`. */
export interface CreatedOriginal extends CreatedObject {
  photographerId: string;
  fileId: string;
  /** The sanitized name segment of the key (not the display name in `files.name`). */
  originalName: string;
}

/**
 * Splits an S3 event `media` message into created originals (key parsed with `parseS3Key`) and everything
 * else (`ignored`: other prefixes, or keys this platform didn't build). The worker:
 *
 * - loads the `files` row by `fileId` and requires `owner_id = photographerId` and
 *   `s3_key = key`; with no such row (aborted, or purged) or a purge-requested row it deletes the
 *   object and stops;
 * - skips rows that are `failed`, and rows that are verified (`verified_at` set) and `ready`, so
 *   redelivery is a no-op;
 * - finishes rows that are verified but not `ready` (an earlier attempt verified the bytes and
 *   then died or failed before the derivatives were written): it writes the derivatives, sends
 *   the faces job and marks the row `ready` without checking or moving the bytes again (they are
 *   already in used_bytes; the guarded UPDATE of drive/quota moves nothing twice);
 * - otherwise HeadObject: the size must equal `files.size_bytes` exactly and the magic bytes must
 *   match `files.mime`, else delete the object, mark `failed` and release the reservation; then
 *   set `verified_at` (and `processing` if the row is still `uploading`: the event can arrive
 *   before the API's complete commits) and move the bytes from reserved to used, all guarded as in
 *   drive/quota. If processing fails after that, the row may become `failed` with `verified_at`
 *   set: its bytes stay in used_bytes until it is purged (fileQuotaBucket).
 *
 * `ignored` objects are logged and dropped (the bucket notification is filtered to `originals/`,
 * so they indicate a misconfiguration).
 */
export function createdOriginals(message: MediaQueueMessage): {
  originals: CreatedOriginal[];
  ignored: CreatedObject[];
} {
  const originals: CreatedOriginal[] = [];
  const ignored: CreatedObject[] = [];
  for (const object of createdObjects(message)) {
    const parsed = parseS3Key(object.key);
    if (parsed?.kind === 'original') {
      originals.push({
        ...object,
        photographerId: parsed.photographerId,
        fileId: parsed.fileId,
        originalName: parsed.originalName,
      });
    } else {
      ignored.push(object);
    }
  }
  return { originals, ignored };
}

/** One original a `media` message asks the worker to process, whichever variant carried it. */
export interface MediaOriginal {
  /** `s3-event`: an S3 ObjectCreated record; `original.completed`: the API or media.sweep. */
  source: 's3-event' | 'original.completed';
  /** The decoded `originals/` key (`files.s3_key`). */
  key: string;
  photographerId: string;
  fileId: string;
  /** The sanitized name segment of the key (not the display name in `files.name`). */
  originalName: string;
}

/** Why a part of a `media` message is not processed. Keys are not included: they hold file names. */
export type IgnoredMediaReason = 'test-event' | 'other-bucket' | 'not-an-original';

export interface IgnoredMediaObject {
  source: 's3-event';
  reason: IgnoredMediaReason;
}

/**
 * Every original a `media` message asks for, for both variants (the entry point of the worker's
 * media consumer):
 * - `original.completed`: its file (already validated: an `originals/` key of that file);
 * - S3 event: each record of `mediaBucket` whose key is an `originals/` key (parseS3Key); records
 *   of other buckets or with other keys are `ignored` (logged without keys and dropped: the
 *   bucket notification is filtered to `originals/`, so they indicate a misconfiguration); a
 *   TestEvent is one ignored `test-event`.
 *
 * Each original is processed as described at {@link createdOriginals} (row checks, HeadObject
 * size, magic bytes, verify, derivatives, ready, faces job); the variant does not change it.
 */
export function mediaOriginals(
  message: MediaQueueMessage,
  mediaBucket: string,
): { originals: MediaOriginal[]; ignored: IgnoredMediaObject[] } {
  if (isFileCopy(message)) {
    // Not an original to verify and render: thrown, not ignored, so a consumer that predates the
    // variant fails the job instead of dropping it.
    throw new RangeError('file.copy is not an original; handle it with isFileCopy first');
  }
  if (isOriginalCompleted(message)) {
    const parsed = parseS3Key(message.key);
    if (parsed?.kind !== 'original') throw new RangeError('Invalid original.completed key');
    return {
      originals: [
        {
          source: 'original.completed',
          key: message.key,
          photographerId: parsed.photographerId,
          fileId: parsed.fileId,
          originalName: parsed.originalName,
        },
      ],
      ignored: [],
    };
  }
  if (isS3TestEvent(message))
    return { originals: [], ignored: [{ source: 's3-event', reason: 'test-event' }] };
  const originals: MediaOriginal[] = [];
  const ignored: IgnoredMediaObject[] = [];
  for (const object of createdObjects(message)) {
    if (object.bucket !== mediaBucket) {
      ignored.push({ source: 's3-event', reason: 'other-bucket' });
      continue;
    }
    const parsed = parseS3Key(object.key);
    if (parsed?.kind !== 'original') {
      ignored.push({ source: 's3-event', reason: 'not-an-original' });
      continue;
    }
    originals.push({
      source: 's3-event',
      key: object.key,
      photographerId: parsed.photographerId,
      fileId: parsed.fileId,
      originalName: parsed.originalName,
    });
  }
  return { originals, ignored };
}
