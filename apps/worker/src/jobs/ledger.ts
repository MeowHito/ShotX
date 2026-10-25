import type { ScheduledJobType } from '@shotx/shared';

/**
 * Remembers which scheduled runs finished, keyed by (type, scheduledTime), so a redelivered or
 * retried Scheduler message doesn't run the job again. Only successful runs are recorded: a run
 * that failed or was interrupted runs again on redelivery. Every job is idempotent anyway, so a
 * lost record (or two concurrent deliveries) costs work, not correctness.
 */
export interface JobRunLedger {
  isDone(type: ScheduledJobType, scheduledTime: string): Promise<boolean>;
  markDone(type: ScheduledJobType, scheduledTime: string): Promise<void>;
}

/** The subset of ioredis the ledger uses. */
export interface RedisLedgerClient {
  exists(key: string): Promise<number>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** Redis ledger. Every key has a TTL (ADR 0005: Redis never evicts). */
export class RedisJobRunLedger implements JobRunLedger {
  constructor(
    private readonly redis: RedisLedgerClient,
    private readonly prefix: string,
    private readonly ttlSeconds: number,
  ) {}

  private key(type: string, scheduledTime: string): string {
    // Normalize so `...Z` and `...+00:00` of the same instant dedupe together.
    const instant = new Date(scheduledTime).toISOString();
    return `${this.prefix}:${type}:${instant}`;
  }

  async isDone(type: ScheduledJobType, scheduledTime: string): Promise<boolean> {
    return (await this.redis.exists(this.key(type, scheduledTime))) > 0;
  }

  async markDone(type: ScheduledJobType, scheduledTime: string): Promise<void> {
    await this.redis.set(this.key(type, scheduledTime), '1', 'EX', this.ttlSeconds);
  }
}

export class MemoryJobRunLedger implements JobRunLedger {
  readonly done = new Set<string>();

  isDone(type: ScheduledJobType, scheduledTime: string): Promise<boolean> {
    return Promise.resolve(this.done.has(`${type}:${new Date(scheduledTime).toISOString()}`));
  }

  markDone(type: ScheduledJobType, scheduledTime: string): Promise<void> {
    this.done.add(`${type}:${new Date(scheduledTime).toISOString()}`);
    return Promise.resolve();
  }
}
