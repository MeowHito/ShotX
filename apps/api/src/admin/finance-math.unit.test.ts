import { describe, expect, it } from 'vitest';
import {
  accruedMonths,
  allocateUserCost,
  daysInMonth,
  escapeLike,
  spreadEstimate,
} from './finance-math';

// ADR 0027 arithmetic: the running-cost spread and the per-user cost allocation.

describe('daysInMonth', () => {
  it('knows month lengths and leap years', () => {
    expect(daysInMonth('2026-01-15')).toBe(31);
    expect(daysInMonth('2026-02-01')).toBe(28);
    expect(daysInMonth('2028-02-29')).toBe(29);
    expect(daysInMonth('2026-04-30')).toBe(30);
    expect(daysInMonth('2026-12-31')).toBe(31);
  });
});

describe('spreadEstimate', () => {
  const monthly = 310_000;

  it('accrues monthly / days-in-month per day, rounded per bucket', () => {
    const daily = spreadEstimate(
      { from: '2026-01-30', to: '2026-02-02', bucket: 'day' },
      '2026-12-31',
      monthly,
    );
    expect([...daily]).toEqual([
      ['2026-01-30', 10_000],
      ['2026-01-31', 10_000],
      ['2026-02-01', Math.round(monthly / 28)],
      ['2026-02-02', Math.round(monthly / 28)],
    ]);
  });

  it('a full calendar month costs exactly one month, partial months pro rata', () => {
    const months = spreadEstimate(
      { from: '2026-01-17', to: '2026-03-31', bucket: 'month' },
      '2026-12-31',
      monthly,
    );
    expect([...months]).toEqual([
      ['2026-01', 15 * 10_000],
      ['2026-02', monthly],
      ['2026-03', monthly],
    ]);
  });

  it('accrues nothing after today, and nothing at all with no cost', () => {
    const clipped = spreadEstimate(
      { from: '2026-03-30', to: '2026-04-05', bucket: 'month' },
      '2026-03-31',
      monthly,
    );
    expect([...clipped]).toEqual([['2026-03', 20_000]]);
    const future = spreadEstimate(
      { from: '2026-05-01', to: '2026-05-05', bucket: 'day' },
      '2026-04-30',
      monthly,
    );
    expect(future.size).toBe(0);
    expect(
      spreadEstimate({ from: '2026-01-01', to: '2026-01-31', bucket: 'day' }, '2026-12-31', 0).size,
    ).toBe(0);
  });
});

describe('allocateUserCost', () => {
  const cost = { storageSatangMonth: 3_200, serverSatangMonth: 306_800 };

  it('shares each monthly cost by stored and served bytes, accrued per day since creation', () => {
    expect(accruedMonths('2026-10-01', '2026-10-31')).toBeCloseTo(1, 12);
    expect(accruedMonths('2026-10-02', '2026-10-01')).toBe(0);
    const months = accruedMonths('2026-10-01', '2026-10-25');
    expect(months).toBeCloseTo(25 / 31, 12);
    expect(
      allocateUserCost({
        cost,
        userStorageBytes: 1_000,
        totalStorageBytes: 4_000,
        userBytesServed: 600,
        totalBytesServed: 2_000,
        createdOn: '2026-10-01',
        today: '2026-10-25',
      }),
    ).toEqual({ storage: 645, server: 74_226, total: 74_871 });
  });

  it('is zero when the platform stores or serves nothing, and a share never exceeds 1', () => {
    expect(
      allocateUserCost({
        cost,
        userStorageBytes: 0,
        totalStorageBytes: 0,
        userBytesServed: 0,
        totalBytesServed: 0,
        createdOn: '2026-01-01',
        today: '2026-10-25',
      }),
    ).toEqual({ storage: 0, server: 0, total: 0 });
    const whole = allocateUserCost({
      cost,
      userStorageBytes: 10,
      totalStorageBytes: 5,
      userBytesServed: 1,
      totalBytesServed: 1,
      createdOn: '2026-10-01',
      today: '2026-10-31',
    });
    expect(whole).toEqual({ storage: 3_200, server: 306_800, total: 310_000 });
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('auth.photographer.')).toBe('auth.photographer.');
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });
});
