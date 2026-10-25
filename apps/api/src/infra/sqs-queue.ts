import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type AwsConfig, serializeQueueMessage } from '@shotx/shared';
import type { ApiQueue } from '../config';
import type { QueueMessageInput, QueueSender } from '../tokens';

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
    private readonly urls: Record<ApiQueue, string>,
  ) {}

  async send<Q extends ApiQueue>(queue: Q, message: QueueMessageInput<Q>): Promise<void> {
    const body = serializeQueueMessage(queue, message);
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.urls[queue], MessageBody: body }),
    );
  }
}

/** Records messages instead of sending them (tests). `failing` makes every send reject. */
export class MemoryQueueSender implements QueueSender {
  readonly sent: { queue: ApiQueue; body: string }[] = [];
  failing = false;

  send<Q extends ApiQueue>(queue: Q, message: QueueMessageInput<Q>): Promise<void> {
    if (this.failing) return Promise.reject(new Error('SQS unavailable'));
    this.sent.push({ queue, body: serializeQueueMessage(queue, message) });
    return Promise.resolve();
  }

  messages(queue: ApiQueue): unknown[] {
    return this.sent.filter((m) => m.queue === queue).map((m) => JSON.parse(m.body) as unknown);
  }
}
