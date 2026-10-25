import { QueueMessageError } from '@shotx/shared';
import { type QueueClient, type ReceivedMessage } from '../aws/queue-client';
import { errorFields, type Logger } from '../logger';
import { Heartbeat } from './heartbeat';

/**
 * A message that can never succeed (it doesn't match its queue's schema, or names something
 * that can't exist). The consumer makes it visible again at once so it reaches the DLQ through
 * maxReceiveCount quickly instead of waiting out timeouts.
 */
export class PermanentMessageError extends Error {
  override readonly name = 'PermanentMessageError';
}

/** Why a message's signal was aborted. */
export type AbortReason = 'lost' | 'shutdown';

export class MessageAbortedError extends Error {
  override readonly name = 'MessageAbortedError';
  constructor(readonly reason: AbortReason) {
    super(`Message processing aborted (${reason})`);
  }
}

export interface MessageContext {
  messageId: string;
  receiveCount: number;
  /**
   * Aborted when the message is no longer ours (`lost`: a heartbeat found the receipt handle
   * invalid, so another attempt owns it) or on shutdown. Handlers pass it to long operations and
   * stop at the next safe point.
   */
  signal: AbortSignal;
  log: Logger;
}

export type MessageHandler = (body: string, context: MessageContext) => Promise<void>;

export interface QueueConsumerOptions {
  /** Queue name, for logs. */
  queue: string;
  queueUrl: string;
  client: QueueClient;
  handler: MessageHandler;
  visibilityTimeoutSeconds: number;
  /** Messages per receive (1–10). Received messages wait for a slot with their heartbeat on. */
  batchSize: number;
  /** Messages processed at once. */
  concurrency: number;
  waitTimeSeconds: number;
  /** A failed attempt comes back after min(timeout, base × 2^(receives − 1)) seconds. */
  retryBaseSeconds: number;
  /** On stop, how long running messages may finish before they are released. */
  shutdownGraceMs: number;
  log: Logger;
  now?: () => number;
}

type State = 'waiting' | 'running' | 'settled' | 'released' | 'lost';

interface InFlight {
  message: ReceivedMessage;
  state: State;
  heartbeat: Heartbeat;
  abort: AbortController;
  log: Logger;
  /** Resolves when the handler has returned or thrown (or the message never started). */
  finished: Promise<void>;
  finish: () => void;
}

const RECEIVE_ERROR_BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Seconds until a failed message is retried. */
export function retryDelaySeconds(
  receiveCount: number,
  baseSeconds: number,
  visibilityTimeoutSeconds: number,
): number {
  const exponent = Math.min(Math.max(receiveCount, 1) - 1, 20);
  return Math.min(visibilityTimeoutSeconds, baseSeconds * 2 ** exponent);
}

/**
 * Long-polls one queue, runs the handler for each message, and owns the message lifecycle:
 *
 * - every received message (also those waiting for a slot) is heartbeated every timeout/3;
 * - success deletes the message;
 * - a failure makes the message visible again after a backoff; invalid messages at once. SQS's
 *   redrive policy (maxReceiveCount) moves messages that keep failing to the DLQ, so nothing is
 *   retried forever;
 * - an invalid receipt handle during a heartbeat aborts the handler and the message is left alone
 *   (another attempt owns it);
 * - {@link stop} (SIGTERM) stops receiving, releases waiting messages (visibility 0), gives
 *   running ones `shutdownGraceMs`, then aborts and releases them too.
 */
export class QueueConsumer {
  private stopping = false;
  private readonly receiveAbort = new AbortController();
  private readonly inFlight = new Set<InFlight>();
  private loop: Promise<void> | undefined;
  private stopped: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly options: QueueConsumerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log.child({ queue: options.queue });
  }

  /** Polls until {@link stop}. */
  start(): Promise<void> {
    this.loop ??= this.run();
    return this.loop;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        await this.pollOnce();
        failures = 0;
      } catch (error) {
        if (this.stopping) break;
        const delay =
          RECEIVE_ERROR_BACKOFF_MS[Math.min(failures, RECEIVE_ERROR_BACKOFF_MS.length - 1)];
        failures++;
        this.log.error('receive failed; backing off', { ...errorFields(error), delayMs: delay });
        await sleep(delay ?? 1000, this.receiveAbort.signal);
      }
    }
  }

  /** Receives one batch and processes it to the end. Returns the number of messages received. */
  async pollOnce(): Promise<number> {
    const { client, queueUrl, batchSize, waitTimeSeconds } = this.options;
    const messages = await client.receive(queueUrl, {
      maxMessages: batchSize,
      waitTimeSeconds,
      signal: this.receiveAbort.signal,
    });
    if (messages.length === 0) return 0;
    const receivedAt = this.now();
    const items = messages.map((message) => this.track(message, receivedAt));
    if (this.stopping) {
      await Promise.all(items.map((item) => this.release(item)));
      return messages.length;
    }
    await this.processAll(items);
    return messages.length;
  }

  private track(message: ReceivedMessage, receivedAt: number): InFlight {
    const log = this.log.child({
      messageId: message.messageId,
      receiveCount: message.receiveCount,
    });
    let finish = () => undefined as void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const abort = new AbortController();
    const item: InFlight = {
      message,
      state: 'waiting',
      abort,
      log,
      finished,
      finish,
      heartbeat: new Heartbeat({
        client: this.options.client,
        queueUrl: this.options.queueUrl,
        receiptHandle: message.receiptHandle,
        visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
        receivedAt,
        now: this.now,
        log,
        onLost: () => {
          if (item.state === 'waiting' || item.state === 'running') {
            const wasWaiting = item.state === 'waiting';
            item.state = 'lost';
            abort.abort(new MessageAbortedError('lost'));
            if (wasWaiting) this.untrack(item);
          }
        },
      }),
    };
    this.inFlight.add(item);
    item.heartbeat.start();
    return item;
  }

  private untrack(item: InFlight): void {
    item.heartbeat.stop();
    this.inFlight.delete(item);
    item.finish();
  }

  private async processAll(items: InFlight[]): Promise<void> {
    const queue = [...items];
    const workers = Array.from(
      { length: Math.min(this.options.concurrency, items.length) },
      async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          if (this.stopping || item.state !== 'waiting') continue;
          await this.handle(item);
        }
      },
    );
    await Promise.all(workers);
  }

  private async handle(item: InFlight): Promise<void> {
    item.state = 'running';
    const started = this.now();
    let failure: unknown;
    let ok = false;
    try {
      await this.options.handler(item.message.body, {
        messageId: item.message.messageId,
        receiveCount: item.message.receiveCount,
        signal: item.abort.signal,
        log: item.log,
      });
      ok = true;
    } catch (error) {
      failure = error;
    }
    item.heartbeat.stop();
    const durationMs = this.now() - started;
    try {
      // `released` (shutdown) or `lost`: the message is no longer ours to delete or retry.
      if (item.state !== 'running') {
        item.log.info('message finished after it was released; leaving it to its next attempt', {
          state: item.state,
          durationMs,
        });
        return;
      }
      item.state = 'settled';
      if (ok) {
        await this.settle(item, () =>
          this.options.client.deleteMessage(this.options.queueUrl, item.message.receiptHandle),
        );
        item.log.info('message done', { durationMs });
        return;
      }
      const permanent =
        failure instanceof PermanentMessageError || failure instanceof QueueMessageError;
      const delay = permanent
        ? 0
        : retryDelaySeconds(
            item.message.receiveCount,
            this.options.retryBaseSeconds,
            this.options.visibilityTimeoutSeconds,
          );
      item.log.error(
        permanent
          ? 'invalid message; it goes to the DLQ after maxReceiveCount receives'
          : 'message failed; it will be retried',
        { ...errorFields(failure), durationMs, retryInSeconds: delay },
      );
      await this.settle(item, () =>
        this.options.client.changeVisibility(
          this.options.queueUrl,
          item.message.receiptHandle,
          delay,
        ),
      );
    } finally {
      this.untrack(item);
    }
  }

  private async settle(item: InFlight, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      // The message comes back after its visibility timeout; every handler is idempotent.
      item.log.warn('could not settle the message with SQS', errorFields(error));
    }
  }

  /** Makes a message visible again at once; it is no longer ours. */
  private async release(item: InFlight): Promise<void> {
    if (item.state !== 'waiting' && item.state !== 'running') return;
    const wasWaiting = item.state === 'waiting';
    item.state = 'released';
    item.heartbeat.stop();
    try {
      await this.options.client.changeVisibility(
        this.options.queueUrl,
        item.message.receiptHandle,
        0,
      );
      item.log.info('released message for another worker (visibility 0)');
    } catch (error) {
      item.log.warn('could not release the message', errorFields(error));
    }
    if (wasWaiting) this.untrack(item);
  }

  /**
   * Stops receiving and hands unfinished messages back to SQS: waiting ones at once, running ones
   * after `shutdownGraceMs` (their handlers are aborted). Resolves when every message is settled
   * or released.
   */
  stop(): Promise<void> {
    this.stopped ??= this.shutdown();
    return this.stopped;
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    this.receiveAbort.abort();
    const items = [...this.inFlight];
    const waiting = items.filter((item) => item.state === 'waiting');
    const running = items.filter((item) => item.state === 'running');
    this.log.info('stopping consumer', { waiting: waiting.length, running: running.length });
    await Promise.all(waiting.map((item) => this.release(item)));
    if (running.length === 0) return;
    const allFinished = Promise.all(running.map((item) => item.finished));
    await Promise.race([allFinished, sleep(this.options.shutdownGraceMs)]);
    const unfinished = running.filter((item) => item.state === 'running');
    for (const item of unfinished) item.abort.abort(new MessageAbortedError('shutdown'));
    await Promise.all(unfinished.map((item) => this.release(item)));
  }

  /** Messages received and not yet settled or released (for tests and metrics). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }
}
