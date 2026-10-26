import { z } from 'zod';
import { SCHEDULED_JOB_TYPES, type ScheduledJobType } from './names';

/**
 * Body of a `jobs` queue message. On SQS it is sent by EventBridge Scheduler and `scheduledTime`
 * is the schedule's `<aws.scheduler.scheduled-time>`, e.g. `2026-10-25T17:00:00Z`. On BullMQ the
 * worker builds it per run with {@link scheduledJobMessage} (see there).
 */
export const scheduledJobMessageSchema = z.object({
  type: z.enum(SCHEDULED_JOB_TYPES),
  scheduledTime: z.iso.datetime({ offset: true }),
});
export type ScheduledJobMessage = z.output<typeof scheduledJobMessageSchema>;

/**
 * The `jobs` message of one scheduled run, for BullMQ job schedulers (ADR 0008 section 3).
 *
 * `upsertJobScheduler` stores a static job template, so the message can't come from the job's
 * data: the worker's ledger dedupes on (type, scheduledTime), and a scheduledTime in the template
 * would be the same for every run. The scheduler is upserted with id and job name
 * {@link scheduledJobSchedulerId} / the job type and no data; for each job the worker builds the
 * message from the job name and the run's slot, the time the scheduler planned it for (BullMQ
 * puts it in the job id, `repeat:<schedulerId>:<millis>`), never from the clock when it starts.
 * Retries of one run share its slot, so they dedupe like SQS redeliveries.
 *
 * `slot` is rounded down to whole seconds and written as `YYYY-MM-DDTHH:mm:ssZ`, the format
 * EventBridge used. Throws RangeError for an unknown type or an invalid date.
 */
export function scheduledJobMessage(
  type: ScheduledJobType,
  slot: Date | number,
): ScheduledJobMessage {
  if (!(SCHEDULED_JOB_TYPES as readonly string[]).includes(type)) {
    throw new RangeError(`Unknown scheduled job type ${String(type)}`);
  }
  const ms = typeof slot === 'number' ? slot : slot.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('Invalid scheduled job slot');
  const seconds = new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
  return scheduledJobMessageSchema.parse({ type, scheduledTime: seconds });
}

/** Id (and job name) of the BullMQ job scheduler of a scheduled job type: the type itself. */
export function scheduledJobSchedulerId(type: ScheduledJobType): string {
  return type;
}
