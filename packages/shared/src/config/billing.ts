import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int, intList } from './fields';

// Plan prices and quotas live in the `plans` table (seeded by packages/db, edited by admins).
const billingEnvSchema = z.object({
  /** Prepaid periods PromptPay can buy, in months (spec: 1, 3, 6 or 12). */
  BILLING_PREPAID_MONTHS: intList(1, 36).default([1, 3, 6, 12]),
  /** VAT included in every price, in basis points (700 = 7%). Prices are VAT-inclusive. */
  VAT_RATE_BASIS_POINTS: int(0, 10_000).default(700),
  /** Alert admins when an account's monthly egress exceeds this multiple of its stored bytes. */
  EGRESS_ANOMALY_MULTIPLIER: z.coerce.number().positive().max(10_000).default(20),
});

export interface BillingConfig {
  /** Sorted ascending. */
  prepaidMonths: number[];
  vatRateBasisPoints: number;
  egressAnomalyMultiplier: number;
}

export function loadBillingConfig(env: Env): BillingConfig {
  const e = parseEnv(billingEnvSchema, env, 'billing');
  return {
    prepaidMonths: [...e.BILLING_PREPAID_MONTHS].sort((a, b) => a - b),
    vatRateBasisPoints: e.VAT_RATE_BASIS_POINTS,
    egressAnomalyMultiplier: e.EGRESS_ANOMALY_MULTIPLIER,
  };
}
