/**
 * Sends messages to a queue. Handlers that enqueue follow-up work (media → faces, faces fan-out)
 * use only this, so they work on either runtime. The destination is the queue's address on the
 * active runtime: its URL on SQS, its queue name on BullMQ (see `queueDestinations` in main.ts).
 */
export interface QueueSender {
  sendMessage(destination: string, body: string): Promise<void>;
  /** Sends every body; throws if any of them could not be sent. */
  sendMessages(destination: string, bodies: readonly string[]): Promise<void>;
}
