import {
  bullMqJobOptions,
  bullMqQueueOptions,
  type BullMqQueueSettings,
  parseQueueMessage,
  QUEUE_NAMES,
  queueJobName,
  type QueueName,
} from '@shotx/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { errorFields, type Logger } from '../logger';
import type { QueueSender } from '../queue/sender';

export interface BullMqQueueSenderOptions {
  /** The BullMQ connection (createBullMqConnection); the sender never closes it. */
  connection: Redis;
  /** bullMqPrefix(APP_STAGE). */
  prefix: string;
  queues: Record<QueueName, BullMqQueueSettings>;
  log: Logger;
}

function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/**
 * QueueSender on BullMQ: the destination is the queue name. Each body is validated with the
 * queue's schema (as on the consumer side), named with queueJobName and added as the job's data
 * unchanged, with bullMqJobOptions. No custom job ids (see queueJobName): consumers are
 * idempotent.
 */
export class BullMqQueueSender implements QueueSender {
  private readonly open = new Map<QueueName, Queue<string>>();

  constructor(private readonly options: BullMqQueueSenderOptions) {}

  /** The BullMQ Queue of a queue name, created on first use (also used for job schedulers). */
  queue(name: QueueName): Queue<string> {
    let queue = this.open.get(name);
    if (queue === undefined) {
      const { connection, prefix, queues, log } = this.options;
      queue = new Queue<string>(name, {
        ...bullMqQueueOptions(queues[name], prefix),
        connection,
      });
      queue.on('error', (error) =>
        log.warn('bullmq queue error', { queue: name, ...errorFields(error) }),
      );
      this.open.set(name, queue);
    }
    return queue;
  }

  private target(destination: string): QueueName {
    if (!isQueueName(destination)) throw new RangeError(`Unknown queue ${destination}`);
    return destination;
  }

  async sendMessage(destination: string, body: string): Promise<void> {
    const name = this.target(destination);
    const jobName = queueJobName(name, parseQueueMessage(name, body));
    await this.queue(name).add(jobName, body, bullMqJobOptions(this.options.queues[name]));
  }

  async sendMessages(destination: string, bodies: readonly string[]): Promise<void> {
    if (bodies.length === 0) return;
    const name = this.target(destination);
    const opts = bullMqJobOptions(this.options.queues[name]);
    // Validate everything before adding anything; addBulk is one atomic MULTI.
    const jobs = bodies.map((body) => ({
      name: queueJobName(name, parseQueueMessage(name, body)),
      data: body,
      opts,
    }));
    await this.queue(name).addBulk(jobs);
  }

  async close(): Promise<void> {
    const queues = [...this.open.values()];
    this.open.clear();
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }
}
