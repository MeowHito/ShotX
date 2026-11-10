import type {
  BillingConfig,
  BillingOperatingMode,
  EmailConfig,
  LifecycleDays,
  PaymentGatewayConfig,
  ScheduledJobsConfig,
  ScheduledJobType,
} from '@shotx/shared';
import type { SubscriptionJobDeps } from '../jobs/subscriptions/common';
import type { Logger } from '../logger';
import { createEmailProvider, type SesV2Sender } from './email';
import { createRenewalGateway } from './gateway';

/**
 * Scheduled job types that exist only for online billing (ADR 0010):
 * `subscriptions.transition.daily` holds the subscription lifecycle (grace, expired, purged),
 * auto-renew charges, the T-14/T-7/T-1 reminder emails and receipts. With BILLING_MODE=offline
 * none of them is scheduled or run. Every other scheduled job (rollup, trash purge, face-index
 * expiry, quota reconciliation, sweeps, auth sessions purge) runs in both modes.
 */
export const BILLING_JOB_TYPES: readonly ScheduledJobType[] = ['subscriptions.transition.daily'];

/** True for a job type that runs only with BILLING_MODE=gateway. */
export function isBillingJob(type: ScheduledJobType): boolean {
  return BILLING_JOB_TYPES.includes(type);
}

/** Whether the billing jobs run: only with BILLING_MODE=gateway. */
export function billingJobsEnabled(mode: BillingOperatingMode): boolean {
  return mode === 'gateway';
}

/**
 * The job schedules the worker registers (BullMQ job schedulers): with BILLING_MODE=offline every
 * billing job is disabled whatever its SCHEDULE_*_ENABLED says, so syncJobSchedulers removes a
 * scheduler left from an earlier gateway-mode deployment. Gateway mode keeps the config as is.
 */
export function schedulesForBillingMode(
  schedules: ScheduledJobsConfig,
  mode: BillingOperatingMode,
): ScheduledJobsConfig {
  if (billingJobsEnabled(mode)) return schedules;
  const jobs = { ...schedules.jobs };
  for (const type of BILLING_JOB_TYPES) jobs[type] = { ...jobs[type], enabled: false };
  return { ...schedules, jobs };
}

/** What createSubscriptionJobDeps reads from WorkerConfig. */
export interface SubscriptionJobConfig {
  billingMode: BillingOperatingMode;
  /** Null with BILLING_MODE=offline (loadPaymentGatewayConfig). */
  paymentGateway: PaymentGatewayConfig | null;
  billing: BillingConfig;
  email: EmailConfig;
  lifecycle: LifecycleDays & { reminderDays: readonly number[] };
  publicBaseUrl: string;
}

/**
 * The subscriptions job's dependencies, or null with BILLING_MODE=offline: then no renewal
 * gateway and no email provider are created (the billing emails are their only use in the
 * worker), and the jobs handler acknowledges `subscriptions.transition.daily` without running it.
 * `sesClient` is called only with EMAIL_PROVIDER=ses in gateway mode.
 */
export function createSubscriptionJobDeps(
  config: SubscriptionJobConfig,
  sesClient: () => SesV2Sender,
): Omit<SubscriptionJobDeps, 'faces'> | null {
  if (!billingJobsEnabled(config.billingMode)) return null;
  if (config.paymentGateway === null) {
    // loadPaymentGatewayConfig always returns a config with BILLING_MODE=gateway.
    throw new Error('BILLING_MODE=gateway without a payment gateway configuration');
  }
  return {
    gateway: createRenewalGateway(config.paymentGateway),
    email: createEmailProvider(config.email, sesClient),
    billing: config.billing,
    lifecycle: config.lifecycle,
    publicBaseUrl: config.publicBaseUrl,
  };
}

/** The one start-up line about billing jobs. */
export function logBillingJobs(mode: BillingOperatingMode, log: Logger): void {
  if (billingJobsEnabled(mode)) {
    log.info('billing jobs on (BILLING_MODE=gateway)', { jobs: BILLING_JOB_TYPES.join(',') });
  } else {
    log.info(
      'billing jobs off (BILLING_MODE=offline): no subscription transitions, renewal charges or billing emails',
      { jobs: BILLING_JOB_TYPES.join(',') },
    );
  }
}
