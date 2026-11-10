import { describe, expect, it } from 'vitest';
import { bangkokDateToIso, formatDate, formatGigabytes, todayInBangkok } from './format';

describe('formatGigabytes', () => {
  const GB = 1024 ** 3;
  it('always shows GB', () => {
    expect(formatGigabytes(0)).toBe('0 GB');
    expect(formatGigabytes(1024)).toBe('< 0.01 GB');
    expect(formatGigabytes(1.5 * GB)).toBe('1.5 GB');
    expect(formatGigabytes(12.34 * GB)).toBe('12.3 GB');
    expect(formatGigabytes(1500 * GB)).toBe('1,500 GB');
  });
});

describe('Bangkok dates', () => {
  it('turns a picked date into midnight in Asia/Bangkok', () => {
    expect(bangkokDateToIso('2026-11-10')).toBe('2026-11-10T00:00:00+07:00');
    expect(new Date(bangkokDateToIso('2026-11-10')!).toISOString()).toBe(
      '2026-11-09T17:00:00.000Z',
    );
  });

  it('refuses impossible dates', () => {
    expect(bangkokDateToIso('2026-02-30')).toBeNull();
    expect(bangkokDateToIso('2026-13-01')).toBeNull();
    expect(bangkokDateToIso('')).toBeNull();
    expect(bangkokDateToIso('10/11/2026')).toBeNull();
  });

  it('knows which day it is in Thailand', () => {
    // 18:30 UTC is already the next day in Bangkok.
    expect(todayInBangkok(new Date('2026-11-10T18:30:00Z'))).toBe('2026-11-11');
    expect(todayInBangkok(new Date('2026-11-10T16:59:00Z'))).toBe('2026-11-10');
  });

  it('shows the picked day back unchanged', () => {
    expect(formatDate(bangkokDateToIso('2026-11-10')!)).toBe(formatDate('2026-11-10T05:00:00Z'));
  });
});
