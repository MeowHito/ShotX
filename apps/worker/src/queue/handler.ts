import { QueueMessageError } from '@shotx/shared';
import type { Logger } from '../logger';

/**
 * The contract between a queue runtime (SQS or BullMQ, selected in main.ts) and the media, faces,
 * zip and jobs handlers. Handlers never see which runtime delivers their messages.
 */

/**
 * A message that can never succeed (it doesn't match its queue's schema, or names something that
 * can't exist). SQS makes it visible again at once so it reaches the DLQ through maxReceiveCount
 * quickly; BullMQ fails the job without retries (UnrecoverableError).
 */
export class PermanentMessageError extends Error {
  override readonly name = 'PermanentMessageError';
}

/** True for failures that no retry can fix: PermanentMessageError and QueueMessageError. */
export function isPermanentFailure(error: unknown): boolean {
  return error instanceof PermanentMessageError || error instanceof QueueMessageError;
}

/** Why a message's signal was aborted. */
export type AbortReason = 'lost' | 'shutdown';

export class MessageAbortedError extends Error {
  override readonly name = 'MessageAbortedError';
  constructor(readonly reason: AbortReason) {
    super(`Message processing aborted (${reason})`);
  }
}

export interface MessageContext {
  /** SQS message id, or BullMQ job id. */
  messageId: string;
  /** 1 on the first delivery; above 1 when an earlier delivery failed, was released or lost. */
  receiveCount: number;
  /**
   * Aborted when the message is no longer ours (`lost`: SQS said the receipt handle is invalid, or
   * BullMQ could not renew the job's lock, so another attempt owns it) or on shutdown. Handlers
   * pass it to long operations and stop at the next safe point.
   */
  signal: AbortSignal;
  log: Logger;
}

export type MessageHandler = (body: string, context: MessageContext) => Promise<void>;

/** A running queue consumer: `start` resolves once it has stopped, `stop` drains it. */
export interface QueueConsumerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}
