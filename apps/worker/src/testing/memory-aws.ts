import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type {
  ListedObject,
  ObjectHead,
  ObjectStore,
  UploadStreamOptions,
} from '../aws/object-store';
import {
  type QueueClient,
  type ReceivedMessage,
  ReceiptHandleInvalidError,
  type ReceiveOptions,
} from '../aws/queue-client';

/** In-memory media bucket with call counters. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  /** Open multipart uploads by upload id. */
  readonly uploads = new Map<string, string>();
  readonly calls = {
    put: 0,
    deleted: [] as string[],
    aborted: [] as string[],
    /** Streams opened by getStream, and how many were open at most at the same time. */
    streamsOpened: 0,
    maxOpenStreams: 0,
    /** Every uploadStream call: its key, part size and the largest chunk it received. */
    uploads: [] as Array<{ key: string; partBytes: number; bytes: number; maxChunk: number }>,
  };
  failDeletes = false;
  /** Chunk size getStream emits objects in, so streaming is observable. */
  streamChunkBytes = 64 * 1024;
  /** Keys whose stream fails after the first chunk. */
  readonly failStreams = new Set<string>();
  private openStreams = 0;

  seed(key: string, body: Uint8Array, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  head(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : { size: object.body.length });
  }

  get(key: string): Promise<Uint8Array | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : new Uint8Array(object.body));
  }

  getStream(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (object === undefined)
      return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    this.calls.streamsOpened++;
    this.openStreams++;
    this.calls.maxOpenStreams = Math.max(this.calls.maxOpenStreams, this.openStreams);
    const { body } = object;
    const size = this.streamChunkBytes;
    const fail = this.failStreams.has(key);
    let offset = 0;
    let closed = false;
    const close = () => {
      if (!closed) this.openStreams--;
      closed = true;
    };
    const stream = new Readable({
      read() {
        if (fail && offset > 0) {
          this.destroy(new Error('stream reset'));
          return;
        }
        if (offset >= body.length) {
          this.push(null);
          return;
        }
        this.push(body.subarray(offset, offset + size));
        offset += size;
      },
    });
    stream.once('close', close);
    return Promise.resolve(stream);
  }

  async uploadStream(key: string, body: Readable, options: UploadStreamOptions): Promise<void> {
    const chunks: Buffer[] = [];
    let maxChunk = 0;
    for await (const chunk of body) {
      options.signal?.throwIfAborted();
      const buffer = Buffer.from(chunk as Uint8Array);
      maxChunk = Math.max(maxChunk, buffer.length);
      chunks.push(buffer);
    }
    options.signal?.throwIfAborted();
    const data = Buffer.concat(chunks);
    this.calls.uploads.push({ key, partBytes: options.partBytes, bytes: data.length, maxChunk });
    this.objects.set(key, { body: data, contentType: options.contentType });
  }

  getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (object === undefined)
      return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    return Promise.resolve(new Uint8Array(object.body.subarray(start, end + 1)));
  }

  async download(key: string, path: string): Promise<{ bytes: number; sha256: string }> {
    const object = this.objects.get(key);
    if (object === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    await writeFile(path, object.body);
    return {
      bytes: object.body.length,
      sha256: createHash('sha256').update(object.body).digest('hex'),
    };
  }

  put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.calls.put++;
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    this.calls.put++;
    this.objects.set(key, { body: await readFile(path), contentType });
  }

  deleteObjects(keys: readonly string[]): Promise<void> {
    if (this.failDeletes) return Promise.reject(new Error('DeleteObjects failed'));
    for (const key of keys) {
      this.calls.deleted.push(key);
      this.objects.delete(key);
    }
    return Promise.resolve();
  }

  async *list(prefix: string): AsyncIterable<ListedObject> {
    for (const [key, object] of [...this.objects].sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith(prefix)) yield { key, size: object.body.length };
    }
    await Promise.resolve();
  }

  abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.calls.aborted.push(uploadId);
    this.uploads.delete(uploadId);
    return Promise.resolve();
  }
}

interface StoredMessage {
  messageId: string;
  body: string;
  receiveCount: number;
  receiptHandle: string | null;
  visibleAt: number;
}

/**
 * In-memory SQS queue(s) with visibility timeouts on an injectable clock. Receipt handles change
 * on every receive, and an old handle is rejected like SQS does.
 */
export class MemoryQueueClient implements QueueClient {
  readonly queues = new Map<string, StoredMessage[]>();
  readonly sent: Array<{ queueUrl: string; body: string }> = [];
  readonly visibilityCalls: Array<{ receiptHandle: string; seconds: number; at: number }> = [];
  readonly deleted: string[] = [];
  private seq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly defaultVisibilitySeconds = 30,
  ) {}

  enqueue(queueUrl: string, body: string): string {
    const messageId = `m-${++this.seq}`;
    const queue = this.queues.get(queueUrl) ?? [];
    queue.push({ messageId, body, receiveCount: 0, receiptHandle: null, visibleAt: 0 });
    this.queues.set(queueUrl, queue);
    return messageId;
  }

  receive(queueUrl: string, options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const now = this.now();
    const visible = (this.queues.get(queueUrl) ?? []).filter((m) => m.visibleAt <= now);
    const batch = visible.slice(0, options.maxMessages);
    return Promise.resolve(
      batch.map((m) => {
        m.receiveCount++;
        m.receiptHandle = `rh-${m.messageId}-${m.receiveCount}`;
        m.visibleAt = now + this.defaultVisibilitySeconds * 1000;
        return {
          messageId: m.messageId,
          receiptHandle: m.receiptHandle,
          body: m.body,
          receiveCount: m.receiveCount,
        };
      }),
    );
  }

  private find(queueUrl: string, receiptHandle: string): StoredMessage {
    const message = (this.queues.get(queueUrl) ?? []).find(
      (m) => m.receiptHandle === receiptHandle,
    );
    if (message === undefined) throw new ReceiptHandleInvalidError();
    return message;
  }

  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const message = this.find(queueUrl, receiptHandle);
    this.queues.set(
      queueUrl,
      (this.queues.get(queueUrl) ?? []).filter((m) => m !== message),
    );
    this.deleted.push(message.messageId);
    return Promise.resolve();
  }

  changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    this.visibilityCalls.push({ receiptHandle, seconds, at: this.now() });
    try {
      const message = this.find(queueUrl, receiptHandle);
      message.visibleAt = this.now() + seconds * 1000;
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  sendMessage(queueUrl: string, body: string): Promise<void> {
    this.sent.push({ queueUrl, body });
    return Promise.resolve();
  }

  sendMessages(queueUrl: string, bodies: readonly string[]): Promise<void> {
    for (const body of bodies) this.sent.push({ queueUrl, body });
    return Promise.resolve();
  }

  /** Makes a receipt handle stale, as if the message was redelivered elsewhere. */
  invalidate(queueUrl: string, messageId: string): void {
    const message = (this.queues.get(queueUrl) ?? []).find((m) => m.messageId === messageId);
    if (message !== undefined) message.receiptHandle = `stale-${message.messageId}`;
  }
}
