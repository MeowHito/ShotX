import type { SubscriptionStatus } from '../domain';
import { addDays } from './period';
import { type LifecycleDays, subscriptionDeadlines } from './subscription';

/**
 * Renewal reminders at T-14, T-7 and T-1 (SUBSCRIPTION_REMINDER_DAYS) before `period_end`, for
 * trial and active subscriptions (auto-renew ones too: the email says the card will be charged).
 * The daily job sends at most one per run and subscription: the most urgent reminder that is due
 * (`now >= period_end - d days`, still before period_end) and not yet logged in
 * `subscription_notices` (kind `renewal_reminder`, this period_end, days_before = d). Earlier
 * reminders a missed run skipped are never sent late. Renewing moves period_end, so the next
 * period gets its own reminders.
 *
 * Returns the day count to send (and log), or null.
 */
export function dueRenewalReminder(input: {
  status: SubscriptionStatus;
  periodEnd: Date;
  now: Date;
  /** RetentionConfig.subscription.reminderDays. */
  reminderDays: readonly number[];
  /** days_before values already logged for this subscription and period_end. */
  sentDays: ReadonlySet<number>;
}): number | null {
  if (input.status !== 'trial' && input.status !== 'active') return null;
  const t = input.now.getTime();
  if (t >= input.periodEnd.getTime()) return null;
  const due = input.reminderDays.filter((d) => t >= addDays(input.periodEnd, -d).getTime());
  if (due.length === 0) return null;
  const mostUrgent = Math.min(...due);
  return input.sentDays.has(mostUrgent) ? null : mostUrgent;
}

/**
 * The purge warning: once for an expired subscription, from `purgeAt - purgeWarningDays` until
 * the purge (logged as kind `purge_warning`, days_before = purgeWarningDays).
 */
export function purgeWarningDue(input: {
  status: SubscriptionStatus;
  periodEnd: Date;
  now: Date;
  days: LifecycleDays;
  alreadySent: boolean;
}): boolean {
  if (input.status !== 'expired' || input.alreadySent) return false;
  const d = subscriptionDeadlines(input.periodEnd, input.days);
  const t = input.now.getTime();
  return t >= d.purgeWarningAt.getTime() && t < d.purgeAt.getTime();
}

/**
 * Fair-use alert (Phase 5 admin; the spec's rule): an account is anomalous in a month when its
 * egress (bytes served, `daily_stats.bytes_out` summed over the month) exceeds
 * EGRESS_ANOMALY_MULTIPLIER (20) × its stored bytes (`storage_usage.used_bytes` at month end),
 * and is at least EGRESS_ANOMALY_MIN_BYTES so tiny accounts don't alert. Alerts only; nothing is
 * throttled.
 */
export function isEgressAnomalous(
  usage: { monthlyEgressBytes: number; storedBytes: number },
  rule: { multiplier: number; minBytes: number },
): boolean {
  const { monthlyEgressBytes: egress, storedBytes: stored } = usage;
  for (const [label, v] of [
    ['monthlyEgressBytes', egress],
    ['storedBytes', stored],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer`);
    }
  }
  return egress >= rule.minBytes && egress > rule.multiplier * stored;
}
