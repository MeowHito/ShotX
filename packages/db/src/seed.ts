import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { plans } from './schema/index';

/** Quotas use binary units: 1 GB here is 1024³ bytes, as operating systems display it. */
const GB = 1024 ** 3;

/** THB to satang. */
const thb = (baht: number) => baht * 100;

/** Code of the trial plan; the only plan with `trial_days`. */
export const TRIAL_PLAN_CODE = 'trial';

export interface PlanSeed {
  code: string;
  name: string;
  quotaBytes: number;
  priceMonthSatang: number;
  priceYearSatang: number;
  trialDays: number | null;
}

/**
 * Launch plans from the spec. Prices include 7% VAT. Admins edit plans afterwards, so seeding
 * never overwrites an existing row (see seedPlans).
 */
export const SEED_PLANS: readonly PlanSeed[] = [
  {
    code: TRIAL_PLAN_CODE,
    name: 'Trial',
    quotaBytes: 2 * GB,
    priceMonthSatang: 0,
    priceYearSatang: 0,
    trialDays: 14,
  },
  {
    code: 'starter',
    name: 'Starter',
    quotaBytes: 10 * GB,
    priceMonthSatang: thb(149),
    priceYearSatang: thb(1_490),
    trialDays: null,
  },
  {
    code: 'standard',
    name: 'Standard',
    quotaBytes: 50 * GB,
    priceMonthSatang: thb(390),
    priceYearSatang: thb(3_900),
    trialDays: null,
  },
  {
    code: 'pro',
    name: 'Pro',
    quotaBytes: 200 * GB,
    priceMonthSatang: thb(990),
    priceYearSatang: thb(9_900),
    trialDays: null,
  },
  {
    code: 'studio',
    name: 'Studio',
    quotaBytes: 500 * GB,
    priceMonthSatang: thb(2_290),
    priceYearSatang: thb(22_900),
    trialDays: null,
  },
];

/**
 * Inserts the seed plans that don't exist yet (matched by code) and returns the codes it
 * inserted. Existing plans are left alone, so admin edits survive. Idempotent.
 */
export async function seedPlans<
  TQueryResult extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
>(db: PgDatabase<TQueryResult, TSchema>): Promise<string[]> {
  const inserted = await db
    .insert(plans)
    .values(SEED_PLANS.map((plan) => ({ ...plan })))
    .onConflictDoNothing({ target: plans.code })
    .returning({ code: plans.code });
  return inserted.map((row) => row.code);
}
