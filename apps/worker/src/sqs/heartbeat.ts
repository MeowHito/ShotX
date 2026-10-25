import { SQS_MAX_VISIBILITY_TIMEOUT_SECONDS } from '@shotx/shared';
import { type QueueClient, ReceiptHandleInvalidError } from '../aws/queue-client';
import { errorFields, type Logger } from '../logger';

/** Heartbeats run every third of the visibility timeout (infra/README.md). */
export function heartbeatIntervalMs(visibilityTimeoutSeconds: number): number {
  return Math.floor((visibilityTimeoutSeconds * 1000) / 3);
}

/**
 * The visibility to request `elapsedMs` after the receive: one full timeout, capped so the
 * message is never invisible past SQS's 12 h limit counted from the receive (SQS rejects longer
 * extensions). 0 means the cap is reached and the message can't be extended any more.
 */
export function heartbeatVisibilitySeconds(
  visibilityTimeoutSeconds: number,
  elapsedMs: number,
): number {
  const remaining = Math.floor(SQS_MAX_VISIBILITY_TIMEOUT_SECONDS - elapsedMs / 1000);
  return Math.max(0, Math.min(visibilityTimeoutSeconds, remaining));
}

export interface HeartbeatOptions {
  client: QueueClient;
  queueUrl: string;
  receiptHandle: string;
  visibilityTimeoutSeconds: number;
  /** When the message was received (ms, same clock as `now`). */
  receivedAt: number;
  now: () => number;
  log: Logger;
  /** Called once when SQS says the receipt handle is no longer ours. */
  onLost: () => void;
  /**
   * After a failed ChangeMessageVisibility, the next try comes after a jittered
   * `min(interval, base × 2^(failures − 1))` instead of a full interval, so a brief SQS error
   * doesn't let the visibility timeout run out. Default {@link HEARTBEAT_RETRY_BASE_MS}.
   */
  retryBaseMs?: number;
  /** Random number in [0, 1) for the jitter; defaults to Math.random. */
  random?: () => number;
}

/** First retry after a failed heartbeat: a few seconds, well inside any visibility timeout ≥ 3 s. */
export const HEARTBEAT_RETRY_BASE_MS = 2000;

/**
 * Delay before retrying a failed heartbeat: half to all of `min(intervalMs, base × 2^(n − 1))`
 * after the n-th consecutive failure ("equal jitter", so retries never bunch up at 0).
 */
export function heartbeatRetryDelayMs(
  failures: number,
  intervalMs: number,
  baseMs: number,
  random: () => number,
): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 20);
  const ceiling = Math.min(intervalMs, baseMs * 2 ** exponent);
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Keeps one in-flight message invisible: every timeout/3 it calls ChangeMessageVisibility with
 * `min(timeout, 43200 − seconds since receive)`. Ticks never overlap (each is scheduled after the
 * previous call settles). A failed call is logged and retried after a few seconds with jitter
 * (backing off up to the interval while it keeps failing), except an invalid receipt handle, which
 * stops the heartbeat and calls `onLost`.
 */
export class Heartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private failures = 0;
  private readonly intervalMs: number;

  constructor(private readonly options: HeartbeatOptions) {
    this.intervalMs = heartbeatIntervalMs(options.visibilityTimeoutSeconds);
  }

  start(): void {
    if (this.intervalMs <= 0) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private schedule(delayMs = this.intervalMs): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const { client, queueUrl, receiptHandle, visibilityTimeoutSeconds, receivedAt, now, log } =
      this.options;
    const seconds = heartbeatVisibilitySeconds(visibilityTimeoutSeconds, now() - receivedAt);
    if (seconds <= 0) {
      log.error('heartbeat reached the 12 h visibility cap; the message will be redelivered');
      this.stop();
      return;
    }
    try {
      await client.changeVisibility(queueUrl, receiptHandle, seconds);
      this.failures = 0;
    } catch (error) {
      if (error instanceof ReceiptHandleInvalidError) {
        log.warn('heartbeat lost the message (receipt handle invalid); stopping the job');
        this.stop();
        this.options.onLost();
        return;
      }
      this.failures++;
      const retryInMs = heartbeatRetryDelayMs(
        this.failures,
        this.intervalMs,
        this.options.retryBaseMs ?? HEARTBEAT_RETRY_BASE_MS,
        this.options.random ?? Math.random,
      );
      log.warn('heartbeat failed; retrying soon', {
        ...errorFields(error),
        failures: this.failures,
        retryInMs,
      });
      this.schedule(retryInMs);
      return;
    }
    this.schedule();
  }
}
