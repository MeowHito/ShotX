import { describe, expect, it } from 'vitest';
import {
  bangkokDateToIso,
  formatBytes,
  formatDate,
  formatDateTime,
  formatGigabytes,
  todayInBangkok,
} from './format';

describe('formatGigabytes', () => {
  const GB = 1024 ** 3;
  it('always shows GB', () => {
    expect(formatGigabytes(0, 'th-TH')).toBe('0 GB');
    expect(formatGigabytes(1024, 'th-TH')).toBe('< 0.01 GB');
    expect(formatGigabytes(1.5 * GB, 'th-TH')).toBe('1.5 GB');
    expect(formatGigabytes(12.34 * GB, 'th-TH')).toBe('12.3 GB');
    expect(formatGigabytes(1500 * GB, 'th-TH')).toBe('1,500 GB');
  });

  it('uses the UI language number format', () => {
    for (const locale of ['en-GB', 'zh-CN']) {
      expect(formatGigabytes(1500 * GB, locale)).toBe('1,500 GB');
      expect(formatGigabytes(1.5 * GB, locale)).toBe('1.5 GB');
    }
    // A locale with a decimal comma shows that it is the locale that formats.
    expect(formatGigabytes(1.5 * GB, 'de-DE')).toBe('1,5 GB');
    expect(formatBytes(1_610_612_736, 'en-GB')).toBe('1,610,612,736 B');
  });
});

describe('dates in the UI language', () => {
  const iso = '2026-11-09T17:30:00.000Z'; // 00:30 on 10 Nov in Bangkok
  it('formats in Asia/Bangkok whatever the locale', () => {
    expect(formatDateTime(iso, 'th-TH')).toMatch(/10 พ\.ย\. 2569/);
    expect(formatDateTime(iso, 'en-GB')).toBe('10 Nov 2026, 00:30');
    expect(formatDateTime(iso, 'zh-CN')).toBe('2026年11月10日 00:30');
    expect(formatDate(iso, 'en-GB')).toBe('10 Nov 2026');
    expect(formatDate(iso, 'zh-CN')).toBe('2026年11月10日');
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
    expect(formatDate(bangkokDateToIso('2026-11-10')!, 'th-TH')).toBe(
      formatDate('2026-11-10T05:00:00Z', 'th-TH'),
    );
  });
});
