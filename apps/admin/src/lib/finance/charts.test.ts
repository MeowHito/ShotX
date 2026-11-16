import type { BarSeriesOption } from 'echarts/charts';
import { describe, expect, it } from 'vitest';
import { makeFinance } from '../../../test/fake-admin-api';
import { CHART_PALETTE, type ChartTheme } from '@/lib/charts/theme';
import { formatCompactSatang, formatSatang, formatSignedSatang } from '@/lib/money';
import {
  bucketProfitOf,
  type ChartFormat,
  ESTIMATE_DECAL,
  escapeHtml,
  incomeExpenseOption,
  packageMixOption,
  profitOption,
  SERIES_IDS,
} from './charts';
import { formatBucket } from './range';

const theme = (scheme: 'light' | 'dark'): ChartTheme => ({
  scheme,
  series: CHART_PALETTE[scheme],
  tokens: {
    text: scheme === 'light' ? '#111820' : '#f5f7f8',
    muted: scheme === 'light' ? '#59636a' : '#aab4bb',
    grid: scheme === 'light' ? '#dfe5e8' : '#293138',
    surface: scheme === 'light' ? '#ffffff' : '#0d1114',
    popover: scheme === 'light' ? '#ffffff' : '#141a1f',
  },
});

const format: ChartFormat = {
  money: (s) => formatSatang(s, 'th-TH'),
  signed: (s) => formatSignedSatang(s, 'th-TH'),
  compact: (s) => formatCompactSatang(s, 'th-TH'),
  count: (n) => String(n),
  bucketShort: (b) => formatBucket(b, 'th-TH', 'short'),
  bucketLong: (b) => formatBucket(b, 'th-TH', 'long'),
};

const ieText = {
  income: 'รายรับ',
  manualExpense: 'รายจ่ายที่บันทึก',
  estimatedCost: 'ค่าใช้จ่ายระบบ (ประมาณการ)',
  packageIncome: 'แพ็กเกจ',
  cashIncome: 'เงินสด',
  expenses: 'รายจ่าย',
};

const { series, packageMix } = makeFinance();
const seriesOf = (option: { series?: unknown }) => option.series as BarSeriesOption[];
type Item = { value: number | string; label?: { show: boolean; formatter: string } };
const items = (s: BarSeriesOption) => s.data as Item[];

describe('income vs expenses chart', () => {
  it('has income in slot 1 and expenses (recorded + striped estimate) in slot 2, light and dark', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const [income, manual, estimate] = seriesOf(
        incomeExpenseOption(series, theme(scheme), ieText, format),
      );
      expect(income?.id).toBe(SERIES_IDS.income);
      expect(income?.itemStyle?.color).toBe(CHART_PALETTE[scheme].income);
      expect(manual?.itemStyle?.color).toBe(CHART_PALETTE[scheme].expense);
      expect(estimate?.itemStyle?.color).toBe(CHART_PALETTE[scheme].expense);
      expect(estimate?.itemStyle?.decal).toEqual(ESTIMATE_DECAL);
      expect(manual?.stack).toBe('expense');
      expect(estimate?.stack).toBe('expense');
      expect(income?.stack).toBeUndefined();
    }
    expect(CHART_PALETTE.light).toMatchObject({ income: '#2a78d6', expense: '#eb6834' });
    expect(CHART_PALETTE.dark).toMatchObject({ income: '#3987e5', expense: '#d95926' });
  });

  it('keeps colours by series id when the data changes (a filter change never repaints)', () => {
    const a = seriesOf(incomeExpenseOption(series, theme('light'), ieText, format));
    const b = seriesOf(incomeExpenseOption(series.slice(1), theme('light'), ieText, format));
    expect(b.map((s) => [s.id, s.itemStyle?.color])).toEqual(
      a.map((s) => [s.id, s.itemStyle?.color]),
    );
  });

  it('has one value axis in THB, a legend naming the estimate, and labels only on the largest bars', () => {
    const option = incomeExpenseOption(series, theme('light'), ieText, format);
    expect(Array.isArray(option.yAxis)).toBe(false);
    expect(
      (option.yAxis as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter(
        1_500_000,
      ),
    ).toBe('฿15K');
    expect((option.legend as { data: string[] }).data).toEqual([
      'รายรับ',
      'รายจ่ายที่บันทึก',
      'ค่าใช้จ่ายระบบ (ประมาณการ)',
    ]);
    const [income, manual, estimate] = seriesOf(option);
    // Income peaks on the 16th (฿2,140); expenses too (฿3,100, labelled on the top segment).
    expect(items(income!).map((d) => d.label?.formatter ?? null)).toEqual([null, null, '฿2.1K']);
    expect(items(estimate!).map((d) => d.label?.formatter ?? null)).toEqual([null, null, '฿3.1K']);
    expect(items(manual!).every((d) => d.label === undefined)).toBe(true);
    expect(income?.itemStyle?.borderRadius).toEqual([4, 4, 0, 0]);
  });

  it('shows the bucket and exact THB in the tooltip of the whole band, escaping text', () => {
    const option = incomeExpenseOption(series, theme('light'), ieText, format);
    const tooltip = option.tooltip as {
      trigger: string;
      axisPointer: { type: string };
      formatter: (p: unknown) => string;
    };
    expect(tooltip.trigger).toBe('axis');
    expect(tooltip.axisPointer.type).toBe('shadow');
    const html = tooltip.formatter([{ dataIndex: 0 }]);
    expect(html).toContain('14 พ.ย. 2569');
    expect(html).toContain('฿1,070');
    expect(html).toContain('฿600');
    expect(escapeHtml('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });
});

describe('profit chart', () => {
  it('draws gains in slot 1 up and losses in critical red down, with signed labels on the extremes', () => {
    const option = profitOption(
      series,
      theme('light'),
      { profit: 'กำไร', loss: 'ขาดทุน (−)' },
      format,
    );
    const [profit, loss] = seriesOf(option);
    expect(Array.isArray(option.yAxis)).toBe(false);
    expect(profit?.itemStyle?.color).toBe(CHART_PALETTE.light.income);
    expect(loss?.itemStyle?.color).toBe(CHART_PALETTE.light.critical);
    expect(loss?.itemStyle?.borderRadius).toEqual([0, 0, 4, 4]);
    // Net of VAT, as the totals: 14th 1,070 − 70 − 600 = 400; 15th 500 − 0 − 100 = 400;
    // 16th 2,140 − 140 − 3,100 = −1,100. They add up to totals.profitSatang (−300).
    expect(series.map(bucketProfitOf)).toEqual([40_000, 40_000, -110_000]);
    expect(series.map(bucketProfitOf).reduce((a, b) => a + b, 0)).toBe(
      makeFinance().totals.profitSatang,
    );
    expect(items(profit!).map((d) => d.value)).toEqual([40_000, 40_000, '-']);
    expect(items(loss!).map((d) => d.value)).toEqual(['-', '-', -110_000]);
    // One label per sign: the first largest gain, the largest loss.
    expect(items(profit!).map((d) => d.label?.formatter ?? null)).toEqual(['฿400', null, null]);
    expect(items(loss!)[2]?.label?.formatter).toBe('−฿1,100');
    expect((option.legend as { data: string[] }).data).toEqual(['กำไร', 'ขาดทุน (−)']);
  });

  it('uses the dark steps in dark mode', () => {
    const [profit, loss] = seriesOf(
      profitOption(series, theme('dark'), { profit: 'a', loss: 'b' }, format),
    );
    expect(profit?.itemStyle?.color).toBe('#3987e5');
    expect(loss?.itemStyle?.color).toBe('#e34948');
  });
});

describe('package mix chart', () => {
  it('is one slot-1 series of horizontal bars, largest first, by orders or income', () => {
    const text = { orders: 'จำนวนคำสั่งซื้อ', income: 'รายรับ' };
    const byOrders = packageMixOption(packageMix, 'orders', theme('light'), text, format);
    const s = seriesOf(byOrders);
    expect(s).toHaveLength(1);
    expect(s[0]?.itemStyle?.color).toBe(CHART_PALETTE.light.income);
    expect(byOrders.yAxis as { type: string; data: string[]; inverse: boolean }).toMatchObject({
      type: 'category',
      data: ['7 Days', '3 Days'],
      inverse: true,
    });
    expect(items(s[0]!).map((d) => d.value)).toEqual([2, 1]);
    expect(items(s[0]!).map((d) => d.label?.formatter ?? null)).toEqual(['2', null]);
    const byIncome = seriesOf(packageMixOption(packageMix, 'income', theme('light'), text, format));
    expect(items(byIncome[0]!).map((d) => d.value)).toEqual([214_000, 107_000]);
  });
});
