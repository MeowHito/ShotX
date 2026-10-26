import {
  bullMqJobOptions,
  bullMqProducerRedisOptions,
  bullMqQueueOptions,
  type BullMqQueueSettings,
  parseQueueMessage,
  queueJobName,
  type RedisConfig,
  serializeQueueMessage,
} from '@shotx/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ApiQueue } from '../config';
import type { QueueMessageInput, QueueSender } from '../tokens';
import { withEnqueueTimeout } from './enqueue-timeout';

/**
 * The API's dedicated BullMQ producer connection (ADR 0008 section 3), separate from the cache and
 * rate-limit client: bullMqProducerRedisOptions (credentials, one retry per command, no offline
 * queue, no ready check because the ACL denies INFO), so an enqueue while Redis is down fails at
 * once instead of queueing in memory. Lazy: connectBullMq opens it at start-up. No ioredis
 * `keyPrefix`: BullMQ builds keys from `prefix`.
 */
export function createBullMqConnection(config: RedisConfig): Redis {
  return new Redis(config.url, { ...bullMqProducerRedisOptions(config), lazyConnect: true });
}

/**
 * Opens the producer connection and waits until it is ready, at most `timeoutMs`, while ioredis
 * retries in the background (a Redis that comes up a moment after the API is fine). Without an
 * offline queue nothing can be sent before that, so main.ts calls this before listening and
 * start-up fails with a clear message when Redis stays unreachable (the container's restart
 * policy retries). Afterwards ioredis reconnects on its own; enqueues in between fail fast.
 */
export async function connectBullMq(connection: Redis, timeoutMs: number): Promise<void> {
  const onError = () => undefined; // connection errors are retried; only the deadline counts
  connection.on('error', onError);
  try {
    await withEnqueueTimeout(
      'redis',
      timeoutMs,
      () =>
        new Promise<void>((resolve) => {
          if (connection.status === 'ready') return resolve();
          connection.once('ready', () => resolve());
          if (connection.status === 'wait') connection.connect().catch(() => undefined);
        }),
    );
  } catch {
    connection.disconnect();
    throw new Error(`Queue Redis (BullMQ) is unreachable: not ready within ${timeoutMs} ms`);
  } finally {
    connection.off('error', onError);
  }
}

/** Queue options of one queue on `connection` (shared bullMqQueueOptions). */
export function bullMqQueue(
  name: ApiQueue,
  connection: Redis,
  prefix: string,
  settings: BullMqQueueSettings,
): Queue {
  return new Queue(name, { ...bullMqQueueOptions(settings, prefix), connection });
}

export interface BullMqSenderConfig {
  /** BullMQ `prefix` (bullMqPrefix(APP_STAGE)). */
  prefix: string;
  queues: Record<ApiQueue, BullMqQueueSettings>;
  /** QUEUE_ENQUEUE_TIMEOUT_MS: one `add` at most. */
  enqueueTimeoutMs: number;
}

/**
 * Sends jobs to the `faces` and `zip` BullMQ queues, with the same contract as SqsQueueSender:
 * the job data is the string from serializeQueueMessage (validated with the queue's shared schema;
 * ids only, never face ids, boxes, images or file names), the options the shared
 * bullMqJobOptions, the job name queueJobName (for dashboards; consumers branch on the parsed
 * message). Every `add` has the QUEUE_ENQUEUE_TIMEOUT_MS deadline (withEnqueueTimeout).
 */
export class BullMqQueueSender implements QueueSender {
  private readonly queues: Record<ApiQueue, Queue>;

  constructor(
    connection: Redis,
    private readonly config: BullMqSenderConfig,
  ) {
    const queue = (name: ApiQueue) =>
      bullMqQueue(name, connection, config.prefix, config.queues[name]);
    this.queues = { faces: queue('faces'), zip: queue('zip') };
  }

  async send<Q extends ApiQueue>(queue: Q, message: QueueMessageInput<Q>): Promise<void> {
    const body = serializeQueueMessage(queue, message);
    const name = queueJobName(queue, parseQueueMessage(queue, body));
    const target = this.queues[queue];
    const options = bullMqJobOptions(this.config.queues[queue]);
    await withEnqueueTimeout(queue, this.config.enqueueTimeoutMs, () =>
      target.add(name, body, options),
    );
  }

  /** Closes the Queue objects (not the shared connection: the caller owns it). */
  async close(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
  }
}
