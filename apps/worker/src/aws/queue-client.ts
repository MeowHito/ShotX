import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export interface ReceivedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** ApproximateReceiveCount: 1 on the first delivery. */
  receiveCount: number;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  signal?: AbortSignal;
}

/** The SQS operations the worker uses. Tests use an in-memory implementation. */
export interface QueueClient {
  receive(queueUrl: string, options: ReceiveOptions): Promise<ReceivedMessage[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
  /** Throws ReceiptHandleInvalidError when the message is no longer ours. */
  changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void>;
  sendMessage(queueUrl: string, body: string): Promise<void>;
}

/**
 * The receipt handle no longer refers to an in-flight message of ours: the message was deleted,
 * or became visible again and another receive owns it now.
 */
export class ReceiptHandleInvalidError extends Error {
  override readonly name = 'ReceiptHandleInvalidError';
  constructor(cause?: unknown) {
    super('The receipt handle is no longer valid', { cause });
  }
}

const RECEIPT_ERRORS = new Set([
  'ReceiptHandleIsInvalid',
  'MessageNotInflight',
  'AWS.SimpleQueueService.MessageNotInflight',
]);

/** True for the SQS errors that mean "this receipt handle is not ours any more". */
export function isReceiptHandleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (RECEIPT_ERRORS.has(error.name)) return true;
  // SQS reports an expired handle on ChangeMessageVisibility as InvalidParameterValue.
  return (
    /^InvalidParameterValue(Exception)?$/.test(error.name) &&
    /receipt handle|not available|does not exist/i.test(error.message)
  );
}

export class SqsQueueClient implements QueueClient {
  constructor(private readonly sqs: SQSClient) {}

  async receive(queueUrl: string, options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: options.signal },
    );
    return (response.Messages ?? []).flatMap((m) =>
      m.MessageId === undefined || m.ReceiptHandle === undefined
        ? []
        : [
            {
              messageId: m.MessageId,
              receiptHandle: m.ReceiptHandle,
              body: m.Body ?? '',
              receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? '1') || 1,
            },
          ],
    );
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    } catch (error) {
      throw isReceiptHandleError(error) ? new ReceiptHandleInvalidError(error) : error;
    }
  }

  async changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      throw isReceiptHandleError(error) ? new ReceiptHandleInvalidError(error) : error;
    }
  }

  async sendMessage(queueUrl: string, body: string): Promise<void> {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
  }
}
