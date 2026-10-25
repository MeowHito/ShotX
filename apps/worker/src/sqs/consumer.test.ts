import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLogger, silentLogger } from '../logger';
import { MemoryQueueClient } from '../testing/memory-aws';
import {
  type MessageContext,
  type MessageHandler,
  QueueConsumer,
  retryDelaySeconds,
} from './consumer';
import { Heartbeat, heartbeatIntervalMs, heartbeatVisibilitySeconds } from './heartbeat';

const URL = 'http://sqs.local/queue/media';
const TIMEOUT = 300;

/** A handler whose calls stay pending until the test settles them. */
function controllableHandler() {
  const calls: Array<{
    body: string;
    context: MessageContext;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const handler: MessageHandler = (body, context) =>
    new Promise<void>((resolve, reject) => calls.push({ body, context, resolve, reject }));
  return { handler, calls };
}

function consumer(client: MemoryQueueClient, handler: MessageHandler, overrides = {}) {
  return new QueueConsumer({
    queue: 'media',
    queueUrl: URL,
    client,
    handler,
    visibilityTimeoutSeconds: TIMEOUT,
    batchSize: 2,
    concurrency: 1,
    waitTimeSeconds: 20,
    retryBaseSeconds: 10,
    shutdownGraceMs: 20_000,
    log: silentLogger,
    ...overrides,
  });
}

/** Lets pending promise callbacks run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('heartbeat arithmetic', () => {
  it('beats every third of the timeout', () => {
    expect(heartbeatIntervalMs(300)).toBe(100_000);
    expect(heartbeatIntervalMs(900)).toBe(300_000);
  });

  it('asks for a full timeout, capped at 12 h since the receive', () => {
    expect(heartbeatVisibilitySeconds(300, 100_000)).toBe(300);
    expect(heartbeatVisibilitySeconds(300, (43_200 - 120) * 1000)).toBe(120);
    expect(heartbeatVisibilitySeconds(300, 43_200 * 1000)).toBe(0);
    expect(heartbeatVisibilitySeconds(300, 50_000 * 1000)).toBe(0);
  });

  it('backs failed messages off exponentially up to the timeout', () => {
    expect([1, 2, 3, 6].map((n) => retryDelaySeconds(n, 10, 300))).toEqual([10, 20, 40, 300]);
  });
});

describe('QueueConsumer', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-25T00:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('heartbeats every timeout/3 with a full timeout, also for messages waiting in the batch', async () => {
    const client = new MemoryQueueClient(() => Date.now(), TIMEOUT);
    client.enqueue(URL, 'first');
    client.enqueue(URL, 'second');
    const { handler, calls } = controllableHandler();
    const c = consumer(client, handler);
    const poll = c.pollOnce();
    await flush();
    expect(calls).toHaveLength(1); // concurrency 1: the second waits

    await vi.advanceTimersByTimeAsync(99_999);
    expect(client.visibilityCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.visibilityCalls.map((v) => [v.receiptHandle, v.seconds])).toEqual([
      ['rh-m-1-1', 300],
      ['rh-m-2-1', 300],
    ]);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(client.visibilityCalls).toHaveLength(6);
    expect(
      new Set(client.visibilityCalls.map((v) => v.at - Date.parse('2026-10-25T00:00:00Z'))),
    ).toEqual(new Set([100_000, 200_000, 300_000]));

    calls[0]!.resolve();
    await flush();
    calls[1]!.resolve();
    await poll;
    expect(client.deleted).toEqual(['m-1', 'm-2']);
    // No heartbeats after the messages are settled.
    const count = client.visibilityCalls.length;
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(client.visibilityCalls).toHaveLength(count);
  });

  it('caps the last heartbeat at the 12 h limit and then stops', async () => {
    const client = new MemoryQueueClient(() => Date.now(), TIMEOUT);
    client.enqueue(URL, 'x');
    const [message] = await client.receive(URL, { maxMessages: 1, waitTimeSeconds: 0 });
    const log = memoryLogger();
    const heartbeat = new Heartbeat({
      client,
      queueUrl: URL,
      receiptHandle: message!.receiptHandle,
      visibilityTimeoutSeconds: TIMEOUT,
      receivedAt: Date.now() - (43_200 - 150) * 1000,
      now: () => Date.now(),
      log,
      onLost: () => undefined,
    });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(client.visibilityCalls.map((v) => v.seconds)).toEqual([50]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(client.visibilityCalls).toHaveLength(1);
    expect(heartbeat.isStopped).toBe(true);
    expect(log.entries.some((e) => e.level === 'error' && /12 h/.test(e.msg))).toBe(true);
  });

  it('keeps beating after a transient heartbeat error', async () => {
    const client = new MemoryQueueClient(() => Date.now(), TIMEOUT);
    client.enqueue(URL, 'x');
    const { handler, calls } = controllableHandler();
    const original = client.changeVisibility.bind(client);
    let failures = 1;
    client.changeVisibility = (url, handle, seconds) =>
      failures-- > 0 ? Promise.reject(new Error('throttled')) : original(url, handle, seconds);
    const poll = consumer(client, handler).pollOnce();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(client.visibilityCalls).toHaveLength(1); // the first failed before being recorded
    calls[0]!.resolve();
    await poll;
    expect(client.deleted).toEqual(['m-1']);
  });

  it('aborts the job and leaves the message alone when the receipt handle becomes invalid', async () => {
    const client = new MemoryQueueClient(() => Date.now(), TIMEOUT);
    client.enqueue(URL, 'x');
    const { handler, calls } = controllableHandler();
    const poll = consumer(client, handler).pollOnce();
    await flush();
    client.invalidate(URL, 'm-1');
    await vi.advanceTimersByTimeAsync(100_000);
    const { context } = calls[0]!;
    expect(context.signal.aborted).toBe(true);
    calls[0]!.reject(new Error('stopped'));
    await poll;
    expect(client.deleted).toEqual([]);
    // Only the failed heartbeat: no retry delay, no visibility 0.
    expect(client.visibilityCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(client.visibilityCalls).toHaveLength(1);
  });

  it('retries failures after a backoff and sends invalid messages back at once', async () => {
    const client = new MemoryQueueClient(() => Date.now(), TIMEOUT);
    client.enqueue(URL, 'boom');
    client.enqueue(URL, 'not json');
    const handler: MessageHandler = async (body) => {
      if (body === 'boom') throw new Error('transient');
      const { parseQueueMessage } = await import('@shotx/shared');
      parseQueueMessage('media', body);
    };
    await consumer(client, handler, { concurrency: 2 }).pollOnce();
    expect(client.deleted).toEqual([]);
    expect(client.visibilityCalls.map((v) => [v.receiptHandle, v.seconds])).toEqual([
      ['rh-m-1-1', 10],
      ['rh-m-2-1', 0],
    ]);
  });

  it('on SIGTERM releases waiting messages at once and running ones after the grace', async () => {
    const client = new MemoryQueueClient(() => Date.now(), TIMEOUT);
    client.enqueue(URL, 'running');
    client.enqueue(URL, 'waiting');
    const { handler, calls } = controllableHandler();
    const c = consumer(client, handler);
    const poll = c.pollOnce();
    await flush();
    expect(calls).toHaveLength(1);

    const stopped = c.stop();
    await flush();
    // The waiting message goes back immediately.
    expect(client.visibilityCalls.map((v) => [v.receiptHandle, v.seconds])).toEqual([
      ['rh-m-2-1', 0],
    ]);
    expect(calls[0]!.context.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    await stopped;
    expect(calls[0]!.context.signal.aborted).toBe(true);
    expect(client.visibilityCalls.map((v) => [v.receiptHandle, v.seconds])).toEqual([
      ['rh-m-2-1', 0],
      ['rh-m-1-1', 0],
    ]);

    // The handler finishing late must not delete a message that is no longer ours.
    calls[0]!.resolve();
    await poll;
    expect(client.deleted).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(c.inFlightCount).toBe(0);
  });

  it('on SIGTERM lets a running message finish within the grace', async () => {
    const client = new MemoryQueueClient(() => Date.now(), TIMEOUT);
    client.enqueue(URL, 'running');
    const { handler, calls } = controllableHandler();
    const c = consumer(client, handler);
    const poll = c.pollOnce();
    await flush();
    const stopped = c.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    calls[0]!.resolve();
    await stopped;
    await poll;
    expect(client.deleted).toEqual(['m-1']);
    expect(client.visibilityCalls).toEqual([]);
  });
});
