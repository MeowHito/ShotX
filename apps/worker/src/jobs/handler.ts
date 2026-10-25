import { parseQueueMessage, type ScheduledJobType } from '@shotx/shared';
import type { ObjectStore } from '../aws/object-store';
import type { Db } from '../db';
import type { FaceDeleter } from '../faces';
import { errorFields, type LogFields } from '../logger';
import type { MessageHandler } from '../sqs/consumer';
import type { JobContext } from './context';
import type { JobRunLedger } from './ledger';
import { runQuotaReconcile } from './quota-reconcile';
import { runTrashPurge } from './trash-purge';

export interface JobsHandlerDeps {
  db: Db;
  store: ObjectStore;
  faces: FaceDeleter;
  ledger: JobRunLedger;
  trashRetentionDays: number;
  batchSize: number;
  /** A run stops starting batches after this long (well under SQS's 12 h cap). */
  maxRuntimeMs: number;
  now?: () => number;
}

/**
 * Job types this phase implements. The others (stats rollup, subscription transitions, face
 * expiry and reconciliation) arrive from their schedules already, and are acknowledged with a
 * warning: sending them to the DLQ would only page someone every day for work that doesn't exist
 * yet, and the schedules keep firing, so nothing is lost by dropping a run.
 */
const IMPLEMENTED = new Set<ScheduledJobType>(['trash.purge.daily', 'quota.reconcile.nightly']);

/** Consumer of the `jobs` queue (EventBridge Scheduler), deduped on (type, scheduledTime). */
export function createJobsHandler(deps: JobsHandlerDeps): MessageHandler {
  const now = deps.now ?? Date.now;
  return async (body, context) => {
    const job = parseQueueMessage('jobs', body);
    const log = context.log.child({ jobType: job.type, scheduledTime: job.scheduledTime });

    if (!IMPLEMENTED.has(job.type)) {
      log.warn('scheduled job not implemented in Phase 2; acknowledged without running');
      return;
    }

    try {
      if (await deps.ledger.isDone(job.type, job.scheduledTime)) {
        log.info('scheduled run already done; skipping duplicate delivery');
        return;
      }
    } catch (error) {
      // Running twice is safe (every job is idempotent); not running is not.
      log.warn('job ledger unavailable; running anyway', errorFields(error));
    }

    const started = now();
    const ctx: JobContext = {
      db: deps.db,
      store: deps.store,
      faces: deps.faces,
      log,
      now,
      batchSize: deps.batchSize,
      deadline: started + deps.maxRuntimeMs,
      signal: context.signal,
    };
    let result: LogFields;
    switch (job.type) {
      case 'trash.purge.daily':
        result = { ...(await runTrashPurge(ctx, deps.trashRetentionDays)) };
        break;
      case 'quota.reconcile.nightly':
        result = { ...(await runQuotaReconcile(ctx)) };
        break;
      default:
        return;
    }
    log.info('scheduled job finished', { ...result, durationMs: now() - started });
    if (result.complete === false) {
      log.warn('scheduled job hit its runtime budget; the next run continues');
    }

    try {
      await deps.ledger.markDone(job.type, job.scheduledTime);
    } catch (error) {
      log.warn('could not record the finished run', errorFields(error));
    }
  };
}
