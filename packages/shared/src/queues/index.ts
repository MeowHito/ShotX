import { z } from 'zod';
import { facesQueueMessageSchema } from './faces';
import { scheduledJobMessageSchema } from './jobs';
import { mediaQueueMessageSchema } from './media';
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
