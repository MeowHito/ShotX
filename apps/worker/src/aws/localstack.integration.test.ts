import { randomBytes, randomUUID } from 'node:crypto';
import { CreateBucketCommand, ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { zipKey } from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { streamZip, ZipJobFailure } from '../zip/archive';
import { S3ObjectStore } from './object-store';
import { SqsQueueClient } from './queue-client';

/**
 * Against LocalStack (or any S3/SQS endpoint): AWS_ENDPOINT_URL=http://localhost:4566 with test
 * credentials. Skipped without an endpoint, so CI without LocalStack stays green.
 */
const endpoint = process.env.AWS_ENDPOINT_URL;
const MiB = 1024 * 1024;

describe.skipIf(!endpoint)('S3 and SQS adapters against LocalStack', () => {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  };
  const s3 = new S3Client({ region, endpoint, forcePathStyle: true, credentials });
  const sqs = new SQSClient({ region, endpoint, credentials });
  const bucket = `shotx-worker-it-${randomUUID().slice(0, 8)}`;
  const store = new S3ObjectStore(s3, bucket);
  let queueUrl = '';

  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: `${bucket}-faces` }));
    queueUrl = queue.QueueUrl!;
  });
  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  });

  it('streams a STORE zip of several objects through a real multipart upload', async () => {
    const photographerId = randomUUID();
    const objects = [7 * MiB, 3 * MiB].map((size, i) => ({
      fileId: randomUUID(),
      name: `IMG_${i}.jpg`,
      body: randomBytes(size),
    }));
    for (const o of objects) {
      await store.put(`derived/${photographerId}/${o.fileId}/web.jpg`, o.body, 'image/jpeg');
    }
    const jobId = randomUUID();
    const bytes = await streamZip(
      store,
      zipKey(jobId),
      objects.map((o) => ({
        fileId: o.fileId,
        key: `derived/${photographerId}/${o.fileId}/web.jpg`,
        name: o.name,
        bytes: o.body.length,
        date: new Date('2026-10-20T01:30:00Z'),
      })),
      { maxBytes: 20 * MiB, partBytes: 5 * MiB, signal: new AbortController().signal },
    );
    const head = await store.head(zipKey(jobId));
    expect(head?.size).toBe(bytes);
    expect(bytes).toBeGreaterThan(10 * MiB);

    const stream = await store.getStream(zipKey(jobId));
    let read = 0;
    for await (const chunk of stream) read += (chunk as Buffer).length;
    expect(read).toBe(bytes);
  });

  it('aborts the multipart upload when the byte limit is hit: no object, no parts left', async () => {
    const photographerId = randomUUID();
    const fileId = randomUUID();
    const key = `derived/${photographerId}/${fileId}/web.jpg`;
    await store.put(key, randomBytes(12 * MiB), 'image/jpeg');
    const jobId = randomUUID();
    await expect(
      streamZip(
        store,
        zipKey(jobId),
        [{ fileId, key, name: 'big.jpg', bytes: 12 * MiB, date: new Date() }],
        { maxBytes: 8 * MiB, partBytes: 5 * MiB, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ZipJobFailure);
    expect(await store.head(zipKey(jobId))).toBeNull();
    const uploads = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: zipKey(jobId) }),
    );
    expect(uploads.Uploads ?? []).toEqual([]);
  });

  it('aborts cleanly when the signal fires mid-stream: no crash, no object, no parts left', async () => {
    const photographerId = randomUUID();
    const fileId = randomUUID();
    const key = `derived/${photographerId}/${fileId}/web.jpg`;
    await store.put(key, randomBytes(12 * MiB), 'image/jpeg');
    const jobId = randomUUID();
    const abort = new AbortController();
    const getStream = store.getStream.bind(store);
    const aborting = Object.create(store) as S3ObjectStore;
    aborting.getStream = async (k, signal) => {
      const stream = await getStream(k, signal);
      stream.once('data', () => setTimeout(() => abort.abort(new Error('lost')), 50));
      return stream;
    };
    await expect(
      streamZip(
        aborting,
        zipKey(jobId),
        [{ fileId, key, name: 'big.jpg', bytes: 12 * MiB, date: new Date() }],
        { maxBytes: 20 * MiB, partBytes: 5 * MiB, signal: abort.signal },
      ),
    ).rejects.toThrow('lost');
    expect(await store.head(zipKey(jobId))).toBeNull();
    const uploads = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: zipKey(jobId) }),
    );
    expect(uploads.Uploads ?? []).toEqual([]);
  });

  it('reports the S3 error when the upload itself fails', async () => {
    const photographerId = randomUUID();
    const fileId = randomUUID();
    const key = `derived/${photographerId}/${fileId}/web.jpg`;
    await store.put(key, randomBytes(6 * MiB), 'image/jpeg');
    // Reads from the real bucket, writes to one that doesn't exist.
    const broken = Object.create(store) as S3ObjectStore;
    const missing = new S3ObjectStore(s3, `${bucket}-missing`);
    broken.uploadStream = missing.uploadStream.bind(missing);
    await expect(
      streamZip(
        broken,
        zipKey(randomUUID()),
        [{ fileId, key, name: 'a.jpg', bytes: 6 * MiB, date: new Date() }],
        { maxBytes: 20 * MiB, partBytes: 5 * MiB, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });

  it('gets small objects whole and reports missing ones as null', async () => {
    await store.put('tmp/reconcile/x.json', Buffer.from('{"a":1}'), 'application/json');
    expect(Buffer.from((await store.get('tmp/reconcile/x.json'))!).toString()).toBe('{"a":1}');
    expect(await store.get('tmp/reconcile/missing.json')).toBeNull();
  });

  it('sends messages in SendMessageBatch calls of 10', async () => {
    const queues = new SqsQueueClient(sqs);
    const bodies = Array.from({ length: 23 }, (_, i) => JSON.stringify({ i }));
    await queues.sendMessages(queueUrl, bodies);
    const received = new Set<string>();
    for (let i = 0; i < 10 && received.size < 23; i++) {
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }),
      );
      for (const m of out.Messages ?? []) received.add(m.Body!);
    }
    expect(received).toEqual(new Set(bodies));
  });
});
