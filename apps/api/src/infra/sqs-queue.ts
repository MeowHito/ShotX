import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type AwsConfig, serializeQueueMessage } from '@shotx/shared';
import type { ApiQueue, ApiSqsQueue } from '../config';
import type { QueueMessageInput, QueueSender } from '../tokens';
import { withEnqueueTimeout } from './enqueue-timeout';

/** SQS client for the API's queues (LocalStack in local runs through AWS_ENDPOINT_URL). */
export function createSqsClient(aws: AwsConfig): SQSClient {
  return new SQSClient({
    region: aws.region,
    ...(aws.endpointUrl === null ? {} : { endpoint: aws.endpointUrl }),
  });
}

/**
 * Sends jobs to `faces` and `zip`. Messages are validated with the queue's shared schema
 * (serializeQueueMessage) and carry ids only: never face ids, boxes, images or file names.
 */
export class SqsQueueSender implements QueueSender {
  constructor(
    private readonly client: Pick<SQSClient, 'send'>,
    /** faces and zip only: on SQS, S3 ObjectCreated feeds `media` (API_SQS_QUEUES). */
    private readonly urls: Record<ApiSqsQueue, string>,
    /** QUEUE_ENQUEUE_TIMEOUT_MS: one SendMessage at most (aborted after it). */
    private readonly enqueueTimeoutMs: number,
  ) {}

  async send<Q extends ApiQueue>(queue: Q, message: QueueMessageInput<Q>): Promise<void> {
    const target: ApiQueue = queue;
    if (target === 'media') {
      throw new Error('The api does not send to media on SQS (S3 events feed it)');
    }
    const body = serializeQueueMessage(queue, message);
    const command = new SendMessageCommand({ QueueUrl: this.urls[target], MessageBody: body });
    await withEnqueueTimeout(queue, this.enqueueTimeoutMs, (abortSignal) =>
      this.client.send(command, { abortSignal }),
    );
  }
}

/**
 * Records messages instead of sending them (tests). `failing` makes every send reject;
 * `delegate` sends through a real sender instead (e.g. BullMQ on an unreachable Redis).
 */
export class MemoryQueueSender implements QueueSender {
  readonly sent: { queue: ApiQueue; body: string }[] = [];
  failing = false;
  delegate: QueueSender | null = null;

  send<Q extends ApiQueue>(queue: Q, message: QueueMessageInput<Q>): Promise<void> {
    if (this.delegate !== null) return this.delegate.send(queue, message);
    if (this.failing) return Promise.reject(new Error('SQS unavailable'));
    this.sent.push({ queue, body: serializeQueueMessage(queue, message) });
    return Promise.resolve();
  }

  messages(queue: ApiQueue): unknown[] {
    return this.sent.filter((m) => m.queue === queue).map((m) => JSON.parse(m.body) as unknown);
  }
}
