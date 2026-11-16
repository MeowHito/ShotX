import { CASH_PAYMENT_MAX_SATANG } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { formatCompactSatang, formatSatang, formatSignedSatang, thbToSatang } from './money';

describe('THB → satang', () => {
  it.each([
    ['1500', 150_000],
    ['1,500', 150_000],
    ['1,500.5', 150_050],
    ['1500.50', 150_050],
    ['0.01', 1],
    ['0.29', 29],
    ['1.1', 110],
    [' ฿2,290 ', 229_000],
    ['21474836.47', CASH_PAYMENT_MAX_SATANG],
  ])('%s THB is %i satang', (text, satang) => {
    expect(thbToSatang(text)).toEqual({ ok: true, satang });
  });

  it.each(['', 'abc', '1.234', '-5', '1e3', '1.', '.5', '12 34', '1,5.0.0'])(
    'refuses %j as not an amount',
    (text) => {
      expect(thbToSatang(text)).toEqual({ ok: false, reason: 'invalid' });
    },
  );

  it('refuses zero and amounts above the column maximum', () => {
    expect(thbToSatang('0')).toEqual({ ok: false, reason: 'not_positive' });
    expect(thbToSatang('0.00')).toEqual({ ok: false, reason: 'not_positive' });
    expect(thbToSatang('21474836.48')).toEqual({ ok: false, reason: 'too_large' });
    expect(thbToSatang('999999999999')).toEqual({ ok: false, reason: 'too_large' });
  });

  it('round-trips through the display format without floating-point drift', () => {
    for (const text of ['0.29', '0.07', '1234.56', '19.99']) {
      const parsed = thbToSatang(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.satang % 1).toBe(0);
    }
  });
});

describe('satang → THB display', () => {
  it('shows whole baht without decimals and satang with two', () => {
    expect(formatSatang(150_000, 'th-TH')).toBe('฿1,500');
    expect(formatSatang(150_050, 'th-TH')).toBe('฿1,500.50');
    expect(formatSatang(1, 'th-TH')).toBe('฿0.01');
  });

  it('formats THB in the UI language', () => {
    const plain = (text: string) => text.replace(/\u00a0/g, ' ');
    expect(plain(formatSatang(150_000, 'en-GB'))).toBe('THB 1,500');
    expect(plain(formatSatang(150_050, 'zh-CN'))).toBe('THB 1,500.50');
  });
});

describe('signed and compact baht (finance)', () => {
  it('puts a minus sign before a loss, never only colour', () => {
    expect(formatSignedSatang(-125_000, 'th-TH')).toBe('−฿1,250');
    expect(formatSignedSatang(125_050, 'th-TH')).toBe('฿1,250.50');
    expect(formatSignedSatang(0, 'th-TH')).toBe('฿0');
  });

  it('shortens large amounts for axes', () => {
    expect(formatCompactSatang(15_234_550, 'th-TH')).toBe('฿152.3K');
    expect(formatCompactSatang(-50_000, 'th-TH')).toBe('−฿500');
  });
});
