import { z } from 'zod';
import { SCHEDULED_JOB_TYPES } from './names';

/**
 * Body of a `jobs` queue message, sent by EventBridge Scheduler. `scheduledTime` is the
 * schedule's `<aws.scheduler.scheduled-time>`, e.g. `2026-10-25T17:00:00Z`.
 */
export const scheduledJobMessageSchema = z.object({
  type: z.enum(SCHEDULED_JOB_TYPES),
  scheduledTime: z.iso.datetime({ offset: true }),
});
export type ScheduledJobMessage = z.output<typeof scheduledJobMessageSchema>;
