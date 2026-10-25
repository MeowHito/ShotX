import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client as RealS3Client,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { ObjectStoreError, S3ObjectStore } from './object-store';
import {
  isReceiptHandleError,
  QueueSendError,
  ReceiptHandleInvalidError,
  SqsQueueClient,
} from './queue-client';

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

describe('S3ObjectStore streaming (multipart, aws-sdk-client-mock)', () => {
  const MiB = 1024 * 1024;

  function mockedS3() {
    const s3 = new RealS3Client({
      region: 'ap-southeast-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    });
    const mock = mockClient(s3);
    const parts: number[] = [];
    mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-1' });
    mock.on(UploadPartCommand).callsFake(async (input: { Body: unknown; PartNumber: number }) => {
      const body = input.Body as Uint8Array | Readable;
      let size = 0;
      if (body instanceof Uint8Array) size = body.length;
      else for await (const c of body) size += (c as Buffer).length;
      parts.push(size);
      return { ETag: `"e${input.PartNumber}"` };
    });
    mock.on(CompleteMultipartUploadCommand).resolves({});
    mock.on(AbortMultipartUploadCommand).resolves({});
    mock.on(PutObjectCommand).resolves({});
    return { s3, mock, parts };
  }

  it('uploads a stream in parts of the requested size and completes it', async () => {
    const { s3, mock, parts } = mockedS3();
    const store = new S3ObjectStore(s3, 'bucket');
    const data = Buffer.alloc(12 * MiB, 7);
    await store.uploadStream(
      'tmp/zips/x.zip',
      Readable.from([data.subarray(0, 6 * MiB), data.subarray(6 * MiB)]),
      { contentType: 'application/zip', partBytes: 5 * MiB },
    );
    expect(parts).toEqual([5 * MiB, 5 * MiB, 2 * MiB]);
    expect(mock.commandCalls(CreateMultipartUploadCommand)[0]!.args[0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'tmp/zips/x.zip',
      ContentType: 'application/zip',
    });
    expect(mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
  });

  it('never completes the upload (or puts an object) when the stream fails', async () => {
    const { s3, mock } = mockedS3();
    const store = new S3ObjectStore(s3, 'bucket');
    async function* broken() {
      yield Buffer.alloc(6 * MiB);
      await Promise.resolve();
      throw new Error('archive failed');
    }
    await expect(
      store.uploadStream('tmp/zips/y.zip', Readable.from(broken()), {
        contentType: 'application/zip',
        partBytes: 5 * MiB,
      }),
    ).rejects.toThrow();
    expect(mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0);
    expect(mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('gets small objects whole, null when missing', async () => {
    const { client } = fakeClient((command) => {
      if ((command.input.Key as string) === 'missing') {
        throw Object.assign(named('NoSuchKey'), { $metadata: { httpStatusCode: 404 } });
      }
      return { Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2])) } };
    });
    const store = new S3ObjectStore(client as unknown as S3Client, 'bucket');
    expect(await store.get('k')).toEqual(new Uint8Array([1, 2]));
    expect(await store.get('missing')).toBeNull();
  });
});

describe('SqsQueueClient.sendMessages', () => {
  it('sends batches of 10 and fails when any entry failed', async () => {
    const { client, sent } = fakeClient((command) =>
      (command.input.Entries as unknown[]).length === 3
        ? { Failed: [{ Id: '0', Code: 'InternalError', SenderFault: false }] }
        : { Successful: [] },
    );
    const sqs = new SqsQueueClient(client as unknown as SQSClient);
    await sqs.sendMessages(
      'url',
      Array.from({ length: 20 }, (_, i) => `m${i}`),
    );
    expect(sent.map((c) => (c.input.Entries as unknown[]).length)).toEqual([10, 10]);
    await expect(sqs.sendMessages('url', ['a', 'b', 'c'])).rejects.toBeInstanceOf(QueueSendError);
  });
});
