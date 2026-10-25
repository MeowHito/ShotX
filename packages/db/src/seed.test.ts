import { describe, expect, it } from 'vitest';
import { SEED_PLANS, TRIAL_PLAN_CODE } from './seed';

const GB = 1024 ** 3;

describe('seed plans', () => {
  it('has the four plans at the spec prices, in satang, plus the trial', () => {
    expect(
      SEED_PLANS.map((p) => [
        p.code,
        p.quotaBytes / GB,
        p.priceMonthSatang,
        p.priceYearSatang,
        p.trialDays,
      ]),
    ).toEqual([
      ['trial', 2, 0, 0, 14],
      ['starter', 10, 14_900, 149_000, null],
      ['standard', 50, 39_000, 390_000, null],
      ['pro', 200, 99_000, 990_000, null],
      ['studio', 500, 229_000, 2_290_000, null],
    ]);
  });

  it('stores money as integer satang and quotas as whole bytes', () => {
    for (const plan of SEED_PLANS) {
      expect(Number.isInteger(plan.priceMonthSatang)).toBe(true);
      expect(Number.isInteger(plan.priceYearSatang)).toBe(true);
      expect(Number.isSafeInteger(plan.quotaBytes)).toBe(true);
      // integer column: must fit in a signed 32-bit int.
      expect(plan.priceYearSatang).toBeLessThan(2 ** 31);
    }
  });

  it('has exactly one trial plan, identified by TRIAL_PLAN_CODE', () => {
    const trials = SEED_PLANS.filter((p) => p.trialDays !== null);
    expect(trials.map((p) => p.code)).toEqual([TRIAL_PLAN_CODE]);
  });

  it('uses codes the plans_code_format check accepts', () => {
    for (const plan of SEED_PLANS) expect(plan.code).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });
});
