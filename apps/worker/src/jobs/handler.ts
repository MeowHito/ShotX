import {
  type DesignAssetConfig,
  parseQueueMessage,
  type ScheduledJobType,
  type WorkerSweepSettings,
} from '@shotx/shared';
import type { ObjectStore } from '../aws/object-store';
import type { Db } from '../db';
import type { FaceProvider } from '@shotx/face';
import { isBillingJob } from '../billing/mode';
import { errorFields, type LogFields } from '../logger';
import type { QueueSender } from '../queue/sender';
import type { MessageHandler } from '../sqs/consumer';
import { runAuthSessionsPurge } from './auth-sessions-purge';
import type { JobContext } from './context';
import { runDesignAssetPurge } from './design-assets-purge';
import { runFacesExpire } from './faces-expire';
import { runFacesReconcile } from './faces-reconcile';
import { runFacesSweep } from './faces-sweep';
import type { JobRunLedger } from './ledger';
import { runMediaSweep } from './media-sweep';
import type { OrphanScanStore } from './orphan-scans';
import { runQuotaReconcile } from './quota-reconcile';
import { runStatsRollup } from './stats-rollup';
import type { SubscriptionJobDeps } from './subscriptions/common';
import { runSubscriptionTransitions } from './subscriptions/run';
import { runTrashPurge } from './trash-purge';

export interface JobsHandlerDeps {
  db: Db;
  store: ObjectStore;
  /**
   * DeleteFaces for purge and expiry, ListFaces for reconciliation, DeleteCollection for the
   * account purge.
   */
  faces: FaceProvider;
  /**
   * subscriptions.transition.daily: gateway, email, billing and lifecycle settings. Null with
   * BILLING_MODE=offline (ADR 0010; createSubscriptionJobDeps): the billing jobs are then
   * acknowledged without running (a schedule left on, or EventBridge on the AWS stacks, may still
   * send them).
   */
  subscriptions: Omit<SubscriptionJobDeps, 'faces'> | null;
  /** Where faces.reconcile.daily keeps scans between runs. */
  orphanScans: OrphanScanStore;
  /** FACE_ORPHAN_GRACE_MS. */
  orphanGraceMs: number;
  ledger: JobRunLedger;
  /** media.sweep, faces.sweep and upload recovery send follow-up messages. */
  queues: QueueSender;
  /** Destinations of `queues` (SQS URLs, or the BullMQ queue names). */
  destinations: { media: string; faces: string };
  /** media.sweep, faces.sweep and auth.sessions.purge.daily settings (WorkerSettings.sweeps). */
  sweeps: WorkerSweepSettings;
  /** AUTH_SESSION_RETENTION_DAYS. */
  authSessionRetentionDays: number;
  /** FACE_SEARCH_ENABLED: faces.sweep sends index jobs only while it is on. */
  faceSearchEnabled: boolean;
  trashRetentionDays: number;
  /** DESIGN_ASSET_ORPHAN_DAYS: trash.purge.daily's design image orphan purge (ADR 0013). */
  designAssets: Pick<DesignAssetConfig, 'orphanDays'>;
  batchSize: number;
  /** A run stops starting batches after this long (well under SQS's 12 h cap). */
  maxRuntimeMs: number;
  now?: () => number;
}

/**
 * Every scheduled job type. A type added to SCHEDULED_JOB_TYPES before the worker implements it
 * is acknowledged with a warning: the DLQ would only page someone every day for work that doesn't
 * exist yet, and the schedule keeps firing, so nothing is lost.
 */
const IMPLEMENTED = new Set<ScheduledJobType>([
  'trash.purge.daily',
  'quota.reconcile.nightly',
  'faces.expire.daily',
  'faces.reconcile.daily',
  'stats.rollup.hourly',
  'subscriptions.transition.daily',
  'media.sweep',
  'faces.sweep',
  'auth.sessions.purge.daily',
]);

/** Consumer of the `jobs` queue (EventBridge Scheduler), deduped on (type, scheduledTime). */
export function createJobsHandler(deps: JobsHandlerDeps): MessageHandler {
  const now = deps.now ?? Date.now;
  return async (body, context) => {
    const job = parseQueueMessage('jobs', body);
    const log = context.log.child({ jobType: job.type, scheduledTime: job.scheduledTime });

    if (!IMPLEMENTED.has(job.type)) {
      log.warn('scheduled job type not implemented; acknowledged without running');
      return;
    }
    if (isBillingJob(job.type) && deps.subscriptions === null) {
      log.info('billing job skipped: BILLING_MODE=offline; acknowledged without running');
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
      queues: deps.queues,
      destinations: deps.destinations,
      log,
      now,
      batchSize: deps.batchSize,
      deadline: started + deps.maxRuntimeMs,
      signal: context.signal,
    };
    let result: LogFields;
    switch (job.type) {
      case 'trash.purge.daily': {
        const trash = await runTrashPurge(ctx, deps.trashRetentionDays);
        // ADR 0013: the design image orphan purge runs in this job (no new schedule).
        const design = await runDesignAssetPurge(ctx, deps.designAssets.orphanDays);
        result = { ...trash, ...design, complete: trash.complete && design.complete };
        break;
      }
      case 'quota.reconcile.nightly':
        result = { ...(await runQuotaReconcile(ctx)) };
        break;
      case 'faces.expire.daily':
        result = { ...(await runFacesExpire(ctx)) };
        break;
      case 'faces.reconcile.daily':
        result = {
          ...(await runFacesReconcile(ctx, {
            provider: deps.faces,
            scans: deps.orphanScans,
            graceMs: deps.orphanGraceMs,
          })),
        };
        break;
      case 'stats.rollup.hourly':
        result = { ...(await runStatsRollup(ctx)) };
        break;
      case 'subscriptions.transition.daily':
        // Never null here: billing jobs returned above while offline.
        if (deps.subscriptions === null) return;
        result = {
          ...(await runSubscriptionTransitions(ctx, { ...deps.subscriptions, faces: deps.faces })),
        };
        break;
      case 'media.sweep':
        result = { ...(await runMediaSweep(ctx, deps.sweeps.media)) };
        break;
      case 'faces.sweep':
        result = {
          ...(await runFacesSweep(ctx, deps.sweeps.faces, { faceSearch: deps.faceSearchEnabled })),
        };
        break;
      case 'auth.sessions.purge.daily':
        result = {
          ...(await runAuthSessionsPurge(ctx, {
            retentionDays: deps.authSessionRetentionDays,
            batchSize: deps.sweeps.authSessionsPurgeBatchSize,
          })),
        };
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
