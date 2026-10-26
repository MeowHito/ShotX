import { randomUUID } from 'node:crypto';
import {
  type NewPayment,
  payments,
  plans,
  seedPlans,
  storageUsage,
  subscriptions,
  users,
} from '@shotx/db';
import { loadBillingConfig, loadRetentionConfig } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { FakeEmailProvider } from '../billing/email';
import { FakeRenewalGateway } from '../billing/gateway';
import type { Db } from '../db';
import type { SubscriptionJobDeps } from '../jobs/subscriptions/common';

/** The default billing and lifecycle settings, a fake gateway and a fake email provider. */
export function testSubscriptionDeps(
  overrides: Partial<Omit<SubscriptionJobDeps, 'faces'>> = {},
): Omit<SubscriptionJobDeps, 'faces'> & {
  gateway: FakeRenewalGateway;
  email: FakeEmailProvider;
} {
  return {
    billing: loadBillingConfig({}),
    lifecycle: loadRetentionConfig({}).subscription,
    publicBaseUrl: 'https://shotx.example',
    ...overrides,
    gateway: (overrides.gateway as FakeRenewalGateway | undefined) ?? new FakeRenewalGateway(),
    email: (overrides.email as FakeEmailProvider | undefined) ?? new FakeEmailProvider(),
  };
}

export type PlanCode = 'trial' | 'starter' | 'standard' | 'pro' | 'studio';

/** Seeds the launch plans (idempotent) and returns their ids by code. */
export async function planIds(db: Db): Promise<Record<PlanCode, string>> {
  await seedPlans(db);
  const all = await db.select({ id: plans.id, code: plans.code }).from(plans);
  return Object.fromEntries(all.map((p) => [p.code, p.id])) as Record<PlanCode, string>;
}

/** A photographer with an email address and a storage_usage row. */
export async function createBillingPhotographer(
  db: Db,
  options: { email?: string | null; usedBytes?: number; reservedBytes?: number } = {},
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      role: 'photographer',
      authPool: 'users',
      authSubject: `local:${randomUUID()}`,
      email:
        options.email === undefined ? `p-${randomUUID().slice(0, 8)}@example.com` : options.email,
    })
    .returning({ id: users.id });
  await db.insert(storageUsage).values({
    photographerId: user!.id,
    usedBytes: options.usedBytes ?? 0,
    reservedBytes: options.reservedBytes ?? 0,
  });
  return user!.id;
}

export interface SubscriptionFixture {
  planId: string;
  status: 'trial' | 'active' | 'grace' | 'expired' | 'purged';
  periodEnd: Date;
  periodStart?: Date;
  autoRenew?: { months: 1 | 12; ref?: string; gateway?: string };
  pendingPlanId?: string;
  pendingPlanEffectiveAt?: Date;
  cancelAtPeriodEnd?: boolean;
  createdAt?: Date;
}

export async function createSubscription(
  db: Db,
  photographerId: string,
  fixture: SubscriptionFixture,
): Promise<string> {
  const periodStart =
    fixture.periodStart ?? new Date(fixture.periodEnd.getTime() - 30 * 86_400_000);
  const [row] = await db
    .insert(subscriptions)
    .values({
      photographerId,
      planId: fixture.planId,
      status: fixture.status,
      periodStart,
      periodEnd: fixture.periodEnd,
      cancelAtPeriodEnd: fixture.cancelAtPeriodEnd ?? false,
      ...(fixture.autoRenew === undefined
        ? { billing: 'prepaid' as const }
        : {
            billing: 'auto_renew' as const,
            autoRenewMonths: fixture.autoRenew.months,
            paymentMethodGateway: fixture.autoRenew.gateway ?? 'fake',
            paymentMethodRef: fixture.autoRenew.ref ?? `card_${randomUUID().slice(0, 8)}`,
          }),
      ...(fixture.pendingPlanId === undefined
        ? {}
        : {
            pendingPlanId: fixture.pendingPlanId,
            pendingPlanEffectiveAt: fixture.pendingPlanEffectiveAt ?? fixture.periodEnd,
          }),
      ...(fixture.createdAt === undefined ? {} : { createdAt: fixture.createdAt }),
    })
    .returning({ id: subscriptions.id });
  return row!.id;
}

export async function subscriptionById(db: Db, id: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row!;
}

let refSeq = 0;

/** A payment row. Migration 0004: `photographer_id` is required. */
export async function createPayment(
  db: Db,
  values: Omit<NewPayment, 'gateway' | 'gatewayRef' | 'method' | 'vatSatang'> &
    Partial<Pick<NewPayment, 'gateway' | 'gatewayRef' | 'method' | 'vatSatang'>>,
): Promise<string> {
  const [row] = await db
    .insert(payments)
    .values({
      gateway: 'fake',
      gatewayRef: `fake_test_${++refSeq}_${randomUUID().slice(0, 8)}`,
      method: 'card',
      vatSatang: 0,
      ...values,
    })
    .returning({ id: payments.id });
  return row!.id;
}
