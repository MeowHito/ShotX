import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { ObjectStoreError, S3ObjectStore } from './object-store';
import { isReceiptHandleError, ReceiptHandleInvalidError, SqsQueueClient } from './queue-client';

type Command = { constructor: { name: string }; input: Record<string, unknown> };

function fakeClient(respond: (command: Command) => unknown) {
  const sent: Command[] = [];
  return {
    sent,
    client: {
      send: (command: Command) => {
        sent.push(command);
        try {
          return Promise.resolve(respond(command));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    },
  };
}

const named = (name: string, message = name) => Object.assign(new Error(message), { name });

describe('SqsQueueClient', () => {
  it('receives with long polling and the receive count', async () => {
    const { client, sent } = fakeClient(() => ({
      Messages: [
        {
          MessageId: 'a',
          ReceiptHandle: 'h',
          Body: '{}',
          Attributes: { ApproximateReceiveCount: '3' },
        },
        { MessageId: 'no-handle' },
      ],
    }));
    const sqs = new SqsQueueClient(client as unknown as SQSClient);
    const messages = await sqs.receive('url', { maxMessages: 10, waitTimeSeconds: 20 });
    expect(messages).toEqual([{ messageId: 'a', receiptHandle: 'h', body: '{}', receiveCount: 3 }]);
    expect(sent[0]?.input).toMatchObject({
      QueueUrl: 'url',
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    });
  });

  it('maps expired receipt handles to ReceiptHandleInvalidError', async () => {
    for (const error of [
      named('ReceiptHandleIsInvalid'),
      named('MessageNotInflight'),
      named(
        'InvalidParameterValue',
        'Value x for parameter ReceiptHandle is invalid. Reason: The receipt handle has expired.',
      ),
    ]) {
      const { client } = fakeClient(() => {
        throw error;
      });
      const sqs = new SqsQueueClient(client as unknown as SQSClient);
      await expect(sqs.changeVisibility('url', 'h', 30)).rejects.toBeInstanceOf(
        ReceiptHandleInvalidError,
      );
    }
    expect(
      isReceiptHandleError(named('InvalidParameterValue', 'VisibilityTimeout too large')),
    ).toBe(false);
    expect(isReceiptHandleError(named('ThrottlingException'))).toBe(false);
  });
});

describe('S3ObjectStore', () => {
  it('treats a missing object as null and an aborted upload that is gone as done', async () => {
    const { client } = fakeClient((command) => {
      if (command.constructor.name === 'HeadObjectCommand') {
        throw Object.assign(named('NotFound'), { $metadata: { httpStatusCode: 404 } });
      }
      throw named('NoSuchUpload');
    });
    const store = new S3ObjectStore(client as unknown as S3Client, 'bucket');
    expect(await store.head('k')).toBeNull();
    await expect(store.abortMultipartUpload('k', 'u')).resolves.toBeUndefined();
  });

  it('downloads with a SHA-256 and batches deletes by 1000, failing on per-key errors', async () => {
    const body = Buffer.from('hello world');
    const { client, sent } = fakeClient((command) => {
      if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([body]) };
      const objects = (command.input.Delete as { Objects: unknown[] }).Objects;
      return objects.length === 1
        ? { Errors: [{ Key: 'originals/x/y/secret.jpg', Code: 'AccessDenied' }] }
        : {};
    });
    const store = new S3ObjectStore(client as unknown as S3Client, 'bucket');
    const dir = await mkdtemp(join(tmpdir(), 'worker-s3-'));
    try {
      const result = await store.download('k', join(dir, 'f'));
      expect(result).toEqual({
        bytes: 11,
        sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      });
      expect(await readFile(join(dir, 'f'), 'utf8')).toBe('hello world');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await store.deleteObjects(Array.from({ length: 2000 }, (_, i) => `k${i}`));
    expect(sent.filter((c) => c.constructor.name === 'DeleteObjectsCommand')).toHaveLength(2);
    const failure = store.deleteObjects(['one']);
    await expect(failure).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(store.deleteObjects(['one'])).rejects.not.toThrow(/secret/);
  });
});
