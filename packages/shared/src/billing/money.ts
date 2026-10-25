import { z } from 'zod';

/**
 * Money is integer satang (1 THB = 100 satang) everywhere: database, API, gateway calls. Every
 * plan price is VAT-inclusive (7%). These helpers are the only place amounts are derived, so api,
 * worker, web (display only) and admin rollups agree to the satang.
 */

/** Largest amount the helpers accept: 1 billion THB, far below 2^53 after multiplying. */
export const MAX_AMOUNT_SATANG = 100_000_000_000;

const BASIS_POINTS = 10_000;

function assertSatang(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT_SATANG) {
    throw new RangeError(`${label} must be an integer amount of satang, got ${value}`);
  }
}

function assertBasisPoints(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > BASIS_POINTS) {
    throw new RangeError(`vatRateBasisPoints must be an integer from 0 to 10000, got ${value}`);
  }
}

/**
 * `round(a × b / c)` for non-negative integers, rounding half up (away from zero), exactly:
 * `floor((2ab + c) / 2c)`. Callers keep `2ab` below 2^53.
 */
export function mulDivRoundHalfUp(a: number, b: number, c: number): number {
  if (c <= 0) throw new RangeError('divisor must be positive');
  return Math.floor((2 * a * b + c) / (2 * c));
}

/**
 * VAT contained in a VAT-inclusive total, in satang. Rule (deterministic, documented for
 * receipts): `vat = round_half_up(total × rate / (10000 + rate))` with the rate in basis points,
 * and `net = total − vat`, so net + VAT always equals the price the customer saw. Example at 7%:
 * 14,900 satang → VAT 975 (974.77 rounded), net 13,925.
 */
export function vatFromInclusive(totalSatang: number, vatRateBasisPoints: number): number {
  assertSatang('totalSatang', totalSatang);
  assertBasisPoints(vatRateBasisPoints);
  return mulDivRoundHalfUp(totalSatang, vatRateBasisPoints, BASIS_POINTS + vatRateBasisPoints);
}

export interface AmountBreakdown {
  /** What the customer pays, VAT included. */
  totalSatang: number;
  vatSatang: number;
  /** `total − vat`. */
  netSatang: number;
  vatRateBasisPoints: number;
}

/** Splits a VAT-inclusive total (see vatFromInclusive). */
export function splitVat(totalSatang: number, vatRateBasisPoints: number): AmountBreakdown {
  const vatSatang = vatFromInclusive(totalSatang, vatRateBasisPoints);
  return { totalSatang, vatSatang, netSatang: totalSatang - vatSatang, vatRateBasisPoints };
}

export const satangSchema = z.number().int().nonnegative().max(MAX_AMOUNT_SATANG);

export const amountBreakdownSchema = z.object({
  totalSatang: satangSchema,
  vatSatang: satangSchema,
  netSatang: satangSchema,
  vatRateBasisPoints: z.number().int().min(0).max(BASIS_POINTS),
});

/** The prices of a plan row (`plans`), VAT-inclusive satang. */
export interface PlanPrices {
  priceMonthSatang: number;
  priceYearSatang: number;
}

/**
 * Price of `months` months of a plan: whole years at the yearly price, the rest at the monthly
 * price (`floor(m / 12) × year + (m mod 12) × month`). So 12 months cost the yearly price (the
 * discount the spec lists), and 1, 3 and 6 months cost 1, 3 and 6 monthly prices.
 */
export function periodPriceSatang(plan: PlanPrices, months: number): number {
  assertSatang('priceMonthSatang', plan.priceMonthSatang);
  assertSatang('priceYearSatang', plan.priceYearSatang);
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new RangeError(`months must be an integer from 1 to 120, got ${months}`);
  }
  const total =
    Math.floor(months / 12) * plan.priceYearSatang + (months % 12) * plan.priceMonthSatang;
  assertSatang('period price', total);
  return total;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ProrationInput {
  /** Monthly price of the current plan and of the bigger plan. */
  fromPriceMonthSatang: number;
  toPriceMonthSatang: number;
  periodEnd: Date;
  now: Date;
  /** BILLING_PRORATION_DAYS_PER_MONTH (30). */
  daysPerMonth: number;
}

export interface Proration {
  /** Started days left until `period_end`, rounded up (a started day counts); 0 once it passed. */
  remainingDays: number;
  /** `round_half_up(max(0, to − from) × remainingDays / daysPerMonth)`. */
  amountSatang: number;
}

/**
 * Charge for an immediate upgrade: the monthly price difference for the remaining days of the
 * current period. Monthly prices are used whatever was paid (a yearly prepayment's discount is
 * not refunded or re-priced). An amount below BILLING_MIN_CHARGE_SATANG is waived: the upgrade
 * applies without a payment (planCheckoutCharge).
 */
export function prorateUpgrade(input: ProrationInput): Proration {
  assertSatang('fromPriceMonthSatang', input.fromPriceMonthSatang);
  assertSatang('toPriceMonthSatang', input.toPriceMonthSatang);
  if (!Number.isInteger(input.daysPerMonth) || input.daysPerMonth < 1) {
    throw new RangeError('daysPerMonth must be a positive integer');
  }
  const remainingMs = input.periodEnd.getTime() - input.now.getTime();
  const remainingDays = remainingMs > 0 ? Math.ceil(remainingMs / MS_PER_DAY) : 0;
  const difference = Math.max(0, input.toPriceMonthSatang - input.fromPriceMonthSatang);
  return {
    remainingDays,
    amountSatang: mulDivRoundHalfUp(difference, remainingDays, input.daysPerMonth),
  };
}
