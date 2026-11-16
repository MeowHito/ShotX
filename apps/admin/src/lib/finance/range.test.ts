import { describe, expect, it } from 'vitest';
import { defaultBucket, formatBucket, presetRange, rangeProblem, selectPreset } from './range';

describe('finance range presets (Bangkok days, both ends inclusive)', () => {
  const today = '2026-11-16';

  it('covers the last 7, 30 and 90 days including today', () => {
    expect(presetRange('7d', today)).toEqual({ from: '2026-11-10', to: today });
    expect(presetRange('30d', today)).toEqual({ from: '2026-10-18', to: today });
    expect(presetRange('90d', today)).toEqual({ from: '2026-08-19', to: today });
  });

  it('this month and this year start on the 1st', () => {
    expect(presetRange('month', today)).toEqual({ from: '2026-11-01', to: today });
    expect(presetRange('year', today)).toEqual({ from: '2026-01-01', to: today });
  });

  it('a year is grouped by month, everything else by day', () => {
    expect(defaultBucket('year')).toBe('month');
    expect(defaultBucket('30d')).toBe('day');
    expect(selectPreset('year', today)).toEqual({
      preset: 'year',
      from: '2026-01-01',
      to: today,
      bucket: 'month',
    });
  });

  it('checks a custom range like the contract', () => {
    expect(rangeProblem('2026-11-01', '2026-11-16', 'day')).toBeNull();
    expect(rangeProblem('', '2026-11-16', 'day')).toBe('invalid');
    expect(rangeProblem('2026-02-30', '2026-11-16', 'day')).toBe('invalid');
    expect(rangeProblem('2026-11-17', '2026-11-16', 'day')).toBe('order');
    // 367 days by day is too long; by month it is fine.
    expect(rangeProblem('2025-11-15', '2026-11-16', 'day')).toBe('too_long');
    expect(rangeProblem('2025-11-15', '2026-11-16', 'month')).toBeNull();
  });

  it('formats bucket keys as calendar dates in the UI language', () => {
    expect(formatBucket('2026-11-16', 'th-TH', 'short')).toBe('16 พ.ย.');
    expect(formatBucket('2026-11-16', 'th-TH', 'long')).toBe('16 พ.ย. 2569');
    expect(formatBucket('2026-11', 'th-TH', 'long')).toBe('พฤศจิกายน 2569');
    expect(formatBucket('2026-11', 'en-GB', 'short')).toBe('Nov 26');
  });
});
