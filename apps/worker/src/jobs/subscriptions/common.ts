import { plans, subscriptionEvents, subscriptions, users } from '@shotx/db';
import type { FaceProvider } from '@shotx/face';
import {
  type AutoRenewMonths,
  BILLING_PAGE_PATH,
  type BillingConfig,
  type EmailProvider,
  type LifecycleDays,
  type SubscriptionEventType,
  type SubscriptionStatus,
  type SubscriptionValues,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import type { RenewalGateway } from '../../billing/gateway';
import type { Db } from '../../db';

export interface SubscriptionJobDeps {
  /** DeleteCollection for the account purge (ADR 0001: through FaceProvider only). */
  faces: Pick<FaceProvider, 'deleteCollection'>;
  gateway: RenewalGateway;
  email: EmailProvider;
  billing: BillingConfig;
  lifecycle: LifecycleDays & {
    /** SUBSCRIPTION_REMINDER_DAYS (14, 7, 1). */
    reminderDays: readonly number[];
  };
  /** PUBLIC_BASE_URL: emails link to PUBLIC_BASE_URL + BILLING_PAGE_PATH. */
  publicBaseUrl: string;
}

export function billingUrl(deps: Pick<SubscriptionJobDeps, 'publicBaseUrl'>): string {
  return new URL(BILLING_PAGE_PATH, deps.publicBaseUrl).toString();
}

export type SubscriptionRow = typeof subscriptions.$inferSelect;

export const subscriptionColumns = {
  id: subscriptions.id,
  photographerId: subscriptions.photographerId,
  planId: subscriptions.planId,
  status: subscriptions.status,
  billing: subscriptions.billing,
  periodStart: subscriptions.periodStart,
  periodEnd: subscriptions.periodEnd,
  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  autoRenewMonths: subscriptions.autoRenewMonths,
  paymentMethodGateway: subscriptions.paymentMethodGateway,
  paymentMethodRef: subscriptions.paymentMethodRef,
  pendingPlanId: subscriptions.pendingPlanId,
  pendingPlanEffectiveAt: subscriptions.pendingPlanEffectiveAt,
  createdAt: subscriptions.createdAt,
  updatedAt: subscriptions.updatedAt,
};

/** The subscription row, optionally locked (`update` or `share`) in the caller's transaction. */
export async function selectSubscription(
  db: Db,
  id: string,
  lock?: 'update' | 'share',
): Promise<SubscriptionRow | undefined> {
  const query = db.select(subscriptionColumns).from(subscriptions).where(eq(subscriptions.id, id));
  const [row] = lock === undefined ? await query : await query.for(lock);
  return row;
}

/** The DB row as the shared lifecycle rules see it. */
export function valuesOf(row: SubscriptionRow): SubscriptionValues {
  return {
    status: row.status,
    planId: row.planId,
    billing: row.billing,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    autoRenewMonths: row.autoRenewMonths as AutoRenewMonths | null,
    paymentMethodGateway: row.paymentMethodGateway,
    paymentMethodRef: row.paymentMethodRef,
    pendingPlanId: row.pendingPlanId,
    pendingPlanEffectiveAt: row.pendingPlanEffectiveAt,
  };
}

/** Writes changed lifecycle values back (and `updated_at`), in the caller's transaction. */
export async function writeValues(
  tx: Db,
  id: string,
  values: SubscriptionValues,
  at: Date,
): Promise<void> {
  await tx
    .update(subscriptions)
    .set({ ...values, updatedAt: at })
    .where(eq(subscriptions.id, id));
}

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  quotaBytes: number;
  priceMonthSatang: number;
  priceYearSatang: number;
}

export async function selectPlan(db: Db, id: string): Promise<PlanRow> {
  const [plan] = await db
    .select({
      id: plans.id,
      code: plans.code,
      name: plans.name,
      quotaBytes: plans.quotaBytes,
      priceMonthSatang: plans.priceMonthSatang,
      priceYearSatang: plans.priceYearSatang,
    })
    .from(plans)
    .where(eq(plans.id, id));
  if (plan === undefined) throw new Error(`plan ${id} not found`);
  return plan;
}

/** The plan in force at `period_end`: the pending downgrade's when it takes effect by then. */
export function planIdAtPeriodEnd(row: SubscriptionRow): string {
  return row.pendingPlanId !== null &&
    row.pendingPlanEffectiveAt !== null &&
    row.pendingPlanEffectiveAt.getTime() <= row.periodEnd.getTime()
    ? row.pendingPlanId
    : row.planId;
}

export async function photographerEmail(db: Db, photographerId: string): Promise<string | null> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, photographerId));
  return user?.email ?? null;
}

export interface EventInput {
  type: SubscriptionEventType;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus;
  fromPlanId: string | null;
  toPlanId: string;
  periodEndBefore: Date | null;
  periodEndAfter: Date;
  paymentId?: string | null;
  meta?: Record<string, string | number | boolean>;
}

/** One subscription_events row by the system (the daily job), in the caller's transaction. */
export async function insertEvent(
  tx: Db,
  row: Pick<SubscriptionRow, 'id' | 'photographerId'>,
  event: EventInput,
): Promise<void> {
  await tx.insert(subscriptionEvents).values({
    subscriptionId: row.id,
    photographerId: row.photographerId,
    actor: 'system',
    actorUserId: null,
    type: event.type,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    fromPlanId: event.fromPlanId,
    toPlanId: event.toPlanId,
    periodEndBefore: event.periodEndBefore,
    periodEndAfter: event.periodEndAfter,
    paymentId: event.paymentId ?? null,
    meta: event.meta ?? {},
  });
}

/** Counters of one `subscriptions.transition.daily` run (logged; no ids or emails). */
export interface SubscriptionRunResult {
  examined: number;
  renewalsCharged: number;
  renewalsPaid: number;
  renewalsPending: number;
  renewalsFailed: number;
  renewalErrors: number;
  downgradesApplied: number;
  graceStarted: number;
  expired: number;
  purged: number;
  purgesIncomplete: number;
  noticesSent: number;
  noticeFailures: number;
  noticesSkippedNoEmail: number;
  receiptsSent: number;
  receiptFailures: number;
  errors: number;
  complete: boolean;
}

export function emptyResult(): SubscriptionRunResult {
  return {
    examined: 0,
    renewalsCharged: 0,
    renewalsPaid: 0,
    renewalsPending: 0,
    renewalsFailed: 0,
    renewalErrors: 0,
    downgradesApplied: 0,
    graceStarted: 0,
    expired: 0,
    purged: 0,
    purgesIncomplete: 0,
    noticesSent: 0,
    noticeFailures: 0,
    noticesSkippedNoEmail: 0,
    receiptsSent: 0,
    receiptFailures: 0,
    errors: 0,
    complete: true,
  };
}
