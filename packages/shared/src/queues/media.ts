import { z } from 'zod';
import { decodeS3EventKey } from '../s3-keys';

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

/** Body of a `media` queue message. */
export const mediaQueueMessageSchema = z.union([s3EventNotificationSchema, s3TestEventSchema]);
export type MediaQueueMessage = z.output<typeof mediaQueueMessageSchema>;

export function isS3TestEvent(message: MediaQueueMessage): message is S3TestEvent {
  return 'Event' in message;
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

/** The objects a `media` message reports as created, keys decoded. Empty for a TestEvent. */
export function createdObjects(message: MediaQueueMessage): CreatedObject[] {
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
