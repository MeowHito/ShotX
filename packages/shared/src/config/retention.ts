import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int, intList } from './fields';

// Timings for the daily scheduled jobs (trash.purge.daily, faces.expire.daily,
// subscriptions.transition.daily). The DPO or legal team reviews these before launch.
const retentionEnvSchema = z.object({
  /** Trashed files are purged this many days after `deleted_at`. */
  TRASH_RETENTION_DAYS: int(1, 365).default(30),
  /** A folder's face index expires this many days after its last upload (extendable). */
  FACE_INDEX_EXPIRY_DAYS: int(1, 3650).default(90),
  /** `grace` lasts this many days after `period_end`; uploads are blocked. */
  SUBSCRIPTION_GRACE_DAYS: int(0, 60).default(14),
  /** An `expired` account is `purged` this many days after it expired (spec: 30–60). */
  SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS: int(30, 60).default(45),
  /** Renewal reminder emails, in days before `period_end` (T-14, T-7, T-1). */
  SUBSCRIPTION_REMINDER_DAYS: intList(1, 60).default([14, 7, 1]),
});

export interface RetentionConfig {
  trashRetentionDays: number;
  faceIndexExpiryDays: number;
  subscription: {
    graceDays: number;
    purgeAfterExpiryDays: number;
    /** Distinct, sorted from earliest (largest) to latest reminder. */
    reminderDays: number[];
  };
}

export function loadRetentionConfig(env: Env): RetentionConfig {
  const e = parseEnv(retentionEnvSchema, env, 'retention');
  return {
    trashRetentionDays: e.TRASH_RETENTION_DAYS,
    faceIndexExpiryDays: e.FACE_INDEX_EXPIRY_DAYS,
    subscription: {
      graceDays: e.SUBSCRIPTION_GRACE_DAYS,
      purgeAfterExpiryDays: e.SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS,
      reminderDays: [...e.SUBSCRIPTION_REMINDER_DAYS].sort((a, b) => b - a),
    },
  };
}
