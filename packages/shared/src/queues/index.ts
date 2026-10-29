import { z } from 'zod';
import { facesQueueMessageSchema } from './faces';
import { scheduledJobMessageSchema } from './jobs';
import {
  isFileCopy,
  isOriginalCompleted,
  isS3TestEvent,
  type MediaQueueMessage,
  mediaQueueMessageSchema,
} from './media';
import type { QueueName } from './names';
import { zipQueueMessageSchema } from './zip';

export * from './names';
export * from './media';
export * from './faces';
export * from './zip';
export * from './jobs';

/** The message body schema of every queue. */
export const QUEUE_MESSAGE_SCHEMAS = {
  media: mediaQueueMessageSchema,
  faces: facesQueueMessageSchema,
  zip: zipQueueMessageSchema,
  jobs: scheduledJobMessageSchema,
} as const satisfies Record<QueueName, z.ZodType>;

export type QueueMessage<Q extends QueueName> = z.output<(typeof QUEUE_MESSAGE_SCHEMAS)[Q]>;

/** A queue message body that is not JSON or doesn't match the queue's schema. */
export class QueueMessageError extends Error {
  override readonly name = 'QueueMessageError';

  constructor(
    readonly queue: QueueName,
    reason: string,
  ) {
    super(`Invalid ${queue} queue message: ${reason}`);
  }
}

/** Parses and validates an SQS message body. Throws QueueMessageError. */
export function parseQueueMessage<Q extends QueueName>(queue: Q, body: string): QueueMessage<Q> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new QueueMessageError(queue, 'body is not JSON');
  }
  const result = QUEUE_MESSAGE_SCHEMAS[queue].safeParse(json);
  if (!result.success) throw new QueueMessageError(queue, z.prettifyError(result.error));
  return result.data as QueueMessage<Q>;
}

/** Validates a message and returns the SQS message body. Throws QueueMessageError. */
export function serializeQueueMessage<Q extends QueueName>(
  queue: Q,
  message: z.input<(typeof QUEUE_MESSAGE_SCHEMAS)[Q]>,
): string {
  const result = QUEUE_MESSAGE_SCHEMAS[queue].safeParse(message);
  if (!result.success) throw new QueueMessageError(queue, z.prettifyError(result.error));
  return JSON.stringify(result.data);
}

/**
 * BullMQ job name of a message (dashboards and logs only; consumers branch on the parsed message,
 * never on the name): `media.original-completed`, `media.file-copy`, `media.object-created` or `media.s3-test-event`, `faces.<type>` (e.g.
 * `faces.index.file`), `zip.create`, and the job type for `jobs`. Don't give jobs custom ids for
 * deduplication: a kept failed or completed job with the same id would silently swallow a later
 * job, while consumers are idempotent anyway.
 */
export function queueJobName<Q extends QueueName>(queue: Q, message: QueueMessage<Q>): string {
  switch (queue) {
    case 'media': {
      const media = message as MediaQueueMessage;
      if (isOriginalCompleted(media)) return 'media.original-completed';
      if (isFileCopy(media)) return 'media.file-copy';
      return isS3TestEvent(media) ? 'media.s3-test-event' : 'media.object-created';
    }
    case 'faces':
      return `faces.${(message as QueueMessage<'faces'>).type}`;
    case 'zip':
      return (message as QueueMessage<'zip'>).type;
    case 'jobs':
      return (message as QueueMessage<'jobs'>).type;
    default:
      throw new RangeError(`Unknown queue ${String(queue)}`);
  }
}
