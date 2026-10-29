import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { contentDispositionAttachment, zipKey } from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { streamZip, ZipJobFailure } from '../zip/archive';
import { CopySourceMissingError, S3ObjectStore } from './object-store';
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

  it('tells an open multipart upload from a completed or aborted one (ListParts)', async () => {
    const key = `originals/${randomUUID()}/${randomUUID()}/a.jpg`;
    const open = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
    expect(await store.multipartUploadExists(key, open.UploadId!)).toBe(true);
    const part = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: open.UploadId!,
        PartNumber: 1,
        Body: randomBytes(1024),
      }),
    );
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: open.UploadId!,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag! }] },
      }),
    );
    // Completed: the upload is gone, the object exists with its size (media.sweep's recovery case).
    expect(await store.multipartUploadExists(key, open.UploadId!)).toBe(false);
    expect(await store.head(key)).toEqual({ size: 1024 });

    const aborted = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: `${key}.b` }),
    );
    await store.abortMultipartUpload(`${key}.b`, aborted.UploadId!);
    expect(await store.multipartUploadExists(`${key}.b`, aborted.UploadId!)).toBe(false);
    expect(await store.head(`${key}.b`)).toBeNull();
  });

  it('copies objects server-side: CopyObject with Thai names, UploadPartCopy for big ones', async () => {
    const photographerId = randomUUID();
    const source = `originals/${photographerId}/${randomUUID()}/งานวิ่ง IMG+1 (2).jpg`;
    const body = randomBytes(11 * MiB);
    await store.put(source, body, 'image/jpeg');

    const small = `originals/${photographerId}/${randomUUID()}/สำเนา a+b.jpg`;
    await store.copy(source, small, { size: body.length, partBytes: 5 * MiB });
    expect(await store.head(small)).toEqual({ size: body.length });
    expect(Buffer.from(await store.getRange(small, 0, 15)).equals(body.subarray(0, 16))).toBe(true);

    // A low single-copy limit makes the same object go through UploadPartCopy (5 MiB parts).
    const multipart = new S3ObjectStore(s3, bucket, 1 * MiB);
    const big = `originals/${photographerId}/${randomUUID()}/big copy.jpg`;
    await multipart.copy(source, big, { size: body.length, partBytes: 5 * MiB });
    expect(await store.head(big)).toEqual({ size: body.length });
    const tail = await store.getRange(big, body.length - 16, body.length - 1);
    expect(Buffer.from(tail).equals(body.subarray(body.length - 16))).toBe(true);
    const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    expect((uploads.Uploads ?? []).filter((u) => u.Key === big)).toEqual([]);

    await expect(
      store.copy(`${source}.missing`, `${small}.x`, { size: 10, partBytes: 5 * MiB }),
    ).rejects.toBeInstanceOf(CopySourceMissingError);
  });

  it('stores Content-Disposition on streamed uploads (owner zips)', async () => {
    const key = zipKey(randomUUID());
    await store.uploadStream(key, Readable.from([Buffer.from('zip')]), {
      contentType: 'application/zip',
      contentDisposition: contentDispositionAttachment('งาน.zip'),
      partBytes: 5 * MiB,
    });
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(head.ContentDisposition).toBe(contentDispositionAttachment('งาน.zip'));
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
