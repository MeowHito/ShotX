import { type BullMqQueueSettings, bullMqWorkerOptions, type QueueName } from '@shotx/shared';
import { type Job, UnrecoverableError, WaitingError, Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { errorFields, type Logger } from '../logger';
import {
  isPermanentFailure,
  MessageAbortedError,
  type MessageHandler,
  type QueueConsumerRuntime,
} from '../queue/handler';
import { storableError } from './options';
import { jobMessageBody } from './schedules';

export interface BullMqConsumerOptions {
  queue: QueueName;
  /** The BullMQ connection (createBullMqConnection); the Worker duplicates it, never closes it. */
  connection: Redis;
  /** bullMqPrefix(APP_STAGE). */
  prefix: string;
  settings: BullMqQueueSettings;
  handler: MessageHandler;
  /** Jobs processed at once (WORKER_<QUEUE>_CONCURRENCY). */
  concurrency: number;
  /** On stop, how long running jobs may finish before their signals are aborted. */
  shutdownGraceMs: number;
  /**
   * After the abort, how long handlers get to stop and hand their jobs back before stop() gives
   * up on them (they then come back through BullMQ's stalled check). Default 5 s; the container's
   * stop timeout must cover shutdownGraceMs plus this.
   */
  abortSettleMs?: number;
  log: Logger;
  /** BullMQ timings for tests (stalledInterval, lockRenewTime, drainDelay). */
  tuning?: Pick<WorkerOptions, 'stalledInterval' | 'lockRenewTime' | 'drainDelay'>;
}

export const DEFAULT_ABORT_SETTLE_MS = 5000;

interface Running {
  abort: AbortController;
  log: Logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Delivery count of a job, like SQS's ApproximateReceiveCount: attemptsMade + 1, or the number of
 * times the job was started when that is higher (a stalled or handed-back job is started again
 * without a failed attempt; the zip consumer must see that as a redelivery).
 */
export function jobReceiveCount(job: Pick<Job, 'attemptsMade' | 'attemptsStarted'>): number {
  return Math.max(job.attemptsMade + 1, job.attemptsStarted);
}

/**
 * Runs a MessageHandler on one BullMQ queue, with the SQS consumer's semantics:
 *
 * - success completes the job; a failure fails the attempt and BullMQ retries it after an
 *   exponential backoff until `attempts` run out, then keeps it in the failed set (the DLQ);
 * - PermanentMessageError and QueueMessageError (also a job without a valid body) fail the job at
 *   once, without retries (UnrecoverableError);
 * - the job's lock is renewed automatically while it runs (the heartbeat); when renewal finds the
 *   lock gone (another worker owns the job now) the handler's signal is aborted (`lost`);
 * - {@link stop} stops taking jobs, gives running ones `shutdownGraceMs`, then aborts their
 *   signals (`shutdown`) and moves them back to waiting without using an attempt.
 */
export class BullMqConsumer implements QueueConsumerRuntime {
  private readonly worker: Worker<unknown, void>;
  private readonly running = new Map<string, Running>();
  private readonly log: Logger;
  private runPromise: Promise<void> | undefined;
  private stopped: Promise<void> | undefined;

  constructor(private readonly options: BullMqConsumerOptions) {
    const { queue, connection, prefix, settings, concurrency } = options;
    this.log = options.log.child({ queue });
    this.worker = new Worker<unknown, void>(queue, (job, token) => this.process(job, token), {
      ...bullMqWorkerOptions(settings, prefix, concurrency),
      connection,
      autorun: false,
      // Fallback for jobs added without them; senders set them per job (bullMqJobOptions).
      removeOnComplete: {
        count: settings.removeOnCompleteCount,
        age: settings.removeOnCompleteAgeSeconds,
      },
      removeOnFail: { count: settings.removeOnFailCount, age: settings.removeOnFailAgeSeconds },
      ...options.tuning,
    });
    this.worker.on('error', (error) => this.log.warn('bullmq worker error', errorFields(error)));
    this.worker.on('lockRenewalFailed', (jobIds) => {
      for (const id of jobIds) this.abort(id, 'lost');
    });
    // A job that stalls more than maxStalledCount times is failed inside BullMQ's Lua script
    // without a worker event; the failed-count alert (ADR 0008 section 7) covers it.
    this.worker.on('stalled', (jobId) =>
      this.log.warn('job stalled (its worker stopped renewing the lock); moved back to waiting', {
        messageId: jobId,
      }),
    );
  }

  /** Processes jobs until {@link stop}. */
  start(): Promise<void> {
    this.runPromise ??= this.worker.run();
    return this.runPromise;
  }

  private abort(jobId: string, reason: 'lost' | 'shutdown'): void {
    const running = this.running.get(jobId);
    if (running === undefined || running.abort.signal.aborted) return;
    running.log.warn(
      reason === 'lost'
        ? 'lost the job lock (another attempt owns it); stopping the job'
        : 'shutdown grace over; stopping the job',
    );
    running.abort.abort(new MessageAbortedError(reason));
  }

  private async process(job: Job<unknown, void>, token: string | undefined): Promise<void> {
    const id = job.id ?? '';
    const receiveCount = jobReceiveCount(job);
    const log = this.log.child({ messageId: id, receiveCount });
    const abort = new AbortController();
    this.running.set(id, { abort, log });
    const started = Date.now();
    try {
      const body = jobMessageBody(this.options.queue, job);
      await this.options.handler(body, { messageId: id, receiveCount, signal: abort.signal, log });
      log.info('message done', { durationMs: Date.now() - started });
    } catch (error) {
      throw await this.failure(job, token, error, abort.signal, log, Date.now() - started);
    } finally {
      this.running.delete(id);
    }
  }

  /** What to throw to BullMQ for a failed handler. */
  private async failure(
    job: Job<unknown, void>,
    token: string | undefined,
    error: unknown,
    signal: AbortSignal,
    log: Logger,
    durationMs: number,
  ): Promise<Error> {
    const reason: unknown = signal.aborted ? signal.reason : undefined;
    if (reason instanceof MessageAbortedError && reason.reason === 'shutdown') {
      try {
        // Back to waiting for another worker; doesn't count as an attempt.
        await job.moveToWait(token);
        log.info('released the job for another worker', { durationMs });
      } catch (moveError) {
        log.warn('could not release the job; the stalled check will', errorFields(moveError));
      }
      return new WaitingError();
    }
    if (reason instanceof MessageAbortedError) {
      // Lost: BullMQ can't move a job whose lock it doesn't hold; the owner settles it.
      log.info('job stopped after its lock was lost; leaving it to its owner', { durationMs });
      return storableError(error);
    }
    if (isPermanentFailure(error)) {
      log.error('invalid message; failed without retries', { ...errorFields(error), durationMs });
      return new UnrecoverableError(storableError(error).message);
    }
    const attempts = job.opts.attempts ?? 1;
    log.error(
      job.attemptsMade + 1 < attempts
        ? 'message failed; it will be retried'
        : 'message failed on its last attempt; kept in the failed set',
      { ...errorFields(error), durationMs, attemptsMade: job.attemptsMade + 1, attempts },
    );
    return storableError(error);
  }

  /**
   * Stops taking jobs and drains: running jobs get `shutdownGraceMs`, then their signals are
   * aborted and they are handed back (at most `abortSettleMs` more). Resolves when the worker is
   * closed or given up on.
   */
  stop(): Promise<void> {
    this.stopped ??= this.shutdown();
    return this.stopped;
  }

  private async shutdown(): Promise<void> {
    const { shutdownGraceMs, abortSettleMs = DEFAULT_ABORT_SETTLE_MS } = this.options;
    this.log.info('stopping consumer', { running: this.running.size });
    let closed = false;
    const closing = this.worker.close().then(
      () => (closed = true),
      (error: unknown) => {
        closed = true;
        this.log.warn('bullmq worker close failed', errorFields(error));
      },
    );
    await Promise.race([closing, sleep(shutdownGraceMs)]);
    if (closed) return;
    const unfinished = [...this.running.entries()];
    for (const [id] of unfinished) this.abort(id, 'shutdown');
    await Promise.race([closing, sleep(abortSettleMs)]);
    if (!closed) {
      this.log.error('jobs did not stop after the abort; leaving them to the stalled check', {
        running: this.running.size,
      });
    }
  }

  /** Jobs currently in the handler (tests and metrics). */
  get runningCount(): number {
    return this.running.size;
  }
}
