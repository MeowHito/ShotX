import type { FinancePackageMix, FinanceSeriesPoint } from '@shotx/shared';
import type { BarSeriesOption } from 'echarts/charts';
import type { ChartOption } from '@/lib/charts/echarts';
import type { ChartTheme } from '@/lib/charts/theme';

/**
 * ECharts options of the finance page (ADR 0027 §5), as pure functions of the data, the theme and
 * the UI language's labels and formatters, so tests can check series, colours and labels without
 * a canvas. The data-viz rules they follow:
 * - bars for per-bucket magnitude, one value axis per chart (profit is its own chart, never a
 *   second y-axis on income vs expenses), horizontal bars for the package mix;
 * - fixed colours per series id (slot 1 income, slot 2 expenses; critical red only for a loss,
 *   with a minus sign and a label), so a filter change never repaints a surviving series;
 * - a 4 px rounded data end anchored at the baseline, a 1 px surface-coloured border around each
 *   bar (2 px between neighbours), a recessive grid, THB axis labels (compact);
 * - a tooltip on the whole category band with exact THB, a legend for 2+ series and direct
 *   labels only on the extremes.
 */

export interface ChartFormat {
  /** Exact THB of satang (`฿1,250.50`). */
  money: (satang: number) => string;
  /** Exact signed THB (`−฿1,250`). */
  signed: (satang: number) => string;
  /** Compact THB for axes and direct labels (`฿1.5K`), signed. */
  compact: (satang: number) => string;
  count: (n: number) => string;
  bucketShort: (bucket: string) => string;
  bucketLong: (bucket: string) => string;
}

export interface IncomeExpenseText {
  income: string;
  manualExpense: string;
  /** Says it is an estimate (legend and tooltip). */
  estimatedCost: string;
  packageIncome: string;
  cashIncome: string;
  expenses: string;
}

export interface ProfitText {
  profit: string;
  loss: string;
}

export interface PackageMixText {
  orders: string;
  income: string;
}

/** Stable ids: ECharts matches series by id, so colours stay with their meaning. */
export const SERIES_IDS = {
  income: 'income',
  manualExpense: 'manual-expense',
  estimatedCost: 'estimated-cost',
  profit: 'profit',
  loss: 'loss',
  packageMix: 'package-mix',
} as const;

const RADIUS = 4;
const TOP_ROUNDED: [number, number, number, number] = [RADIUS, RADIUS, 0, 0];
const BOTTOM_ROUNDED: [number, number, number, number] = [0, 0, RADIUS, RADIUS];
const RIGHT_ROUNDED: [number, number, number, number] = [0, RADIUS, RADIUS, 0];
const SQUARE: [number, number, number, number] = [0, 0, 0, 0];

/** Diagonal light stripes over the expense colour: the estimated part of expenses. */
export const ESTIMATE_DECAL = {
  symbol: 'rect',
  symbolSize: 1,
  dashArrayX: [1, 0],
  dashArrayY: [2, 3],
  rotation: -Math.PI / 4,
  color: 'rgba(255, 255, 255, 0.55)',
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Index of the largest value above zero, or -1. */
export function indexOfMax(values: readonly number[]): number {
  let best = -1;
  values.forEach((v, i) => {
    if (v > 0 && (best === -1 || v > (values[best] ?? 0))) best = i;
  });
  return best;
}

/** Index of the most negative value, or -1. */
export function indexOfMin(values: readonly number[]): number {
  let best = -1;
  values.forEach((v, i) => {
    if (v < 0 && (best === -1 || v < (values[best] ?? 0))) best = i;
  });
  return best;
}

export const incomeOf = (p: FinanceSeriesPoint) => p.packageIncomeSatang + p.cashIncomeSatang;
export const expenseOf = (p: FinanceSeriesPoint) => p.manualExpenseSatang + p.estimatedCostSatang;
/**
 * Profit of a bucket on the totals' basis (profitSatang = net income − expenses): package + cash
 * − the bucket's VAT − recorded − estimated. VAT is owed, not earned.
 */
export const bucketProfitOf = (p: FinanceSeriesPoint) => incomeOf(p) - p.vatSatang - expenseOf(p);

function base(theme: ChartTheme) {
  const { tokens } = theme;
  return {
    animationDuration: 300,
    textStyle: { color: tokens.text, fontFamily: 'inherit' },
    grid: {
      left: 4,
      right: 12,
      top: 40,
      bottom: 4,
      outerBoundsMode: 'same' as const,
      outerBoundsContain: 'axisLabel' as const,
    },
    tooltip: {
      trigger: 'axis' as const,
      confine: true,
      axisPointer: { type: 'shadow' as const, shadowStyle: { color: tokens.grid, opacity: 0.35 } },
      backgroundColor: tokens.popover,
      borderColor: tokens.grid,
      borderWidth: 1,
      textStyle: { color: tokens.text, fontSize: 13 },
    },
    legend: {
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 10,
      textStyle: { color: tokens.text },
    },
  };
}

function categoryAxis(theme: ChartTheme, data: string[]) {
  return {
    type: 'category' as const,
    data,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: theme.tokens.grid } },
    axisLabel: { color: theme.tokens.muted, hideOverlap: true },
  };
}

function valueAxis(theme: ChartTheme, formatter: (value: number) => string) {
  return {
    type: 'value' as const,
    axisLabel: { color: theme.tokens.muted, formatter },
    splitLine: { lineStyle: { color: theme.tokens.grid, width: 1 } },
    axisLine: { show: false },
    axisTick: { show: false },
  };
}

function directLabel(theme: ChartTheme, text: string, position: 'top' | 'bottom' | 'right') {
  return { show: true, position, formatter: text, color: theme.tokens.text, fontWeight: 600 };
}

function swatch(color: string): string {
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;background:${color}"></span>`;
}

function line(color: string | null, label: string, value: string, sub = false): string {
  const marker =
    color === null ? '<span style="display:inline-block;width:16px"></span>' : swatch(color);
  return `<div style="display:flex;justify-content:space-between;gap:16px;${sub ? 'opacity:0.75;font-size:12px' : ''}"><span>${marker}${escapeHtml(label)}</span><b style="font-variant-numeric:tabular-nums">${escapeHtml(value)}</b></div>`;
}

function heading(text: string): string {
  return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(text)}</div>`;
}

/** The index of an axis tooltip's category. */
function dataIndexOf(params: unknown): number {
  const first = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number } | undefined;
  return first?.dataIndex ?? 0;
}

/**
 * (a) Income vs expenses per bucket: income (slot 1) beside expenses (slot 2), expenses stacked
 * as recorded (solid) + estimated (striped, "ประมาณการ" in the legend). Income stays one series
 * (package + cash in the tooltip): stacking it too would put two stacks of two shades side by
 * side, harder to read than one bar each.
 */
export function incomeExpenseOption(
  points: readonly FinanceSeriesPoint[],
  theme: ChartTheme,
  text: IncomeExpenseText,
  format: ChartFormat,
): ChartOption {
  const { series: colors, tokens } = theme;
  const income = points.map(incomeOf);
  const expense = points.map(expenseOf);
  const topIncome = indexOfMax(income);
  const topExpense = indexOfMax(expense);
  const border = { borderColor: tokens.surface, borderWidth: 1 };

  const incomeSeries: BarSeriesOption = {
    id: SERIES_IDS.income,
    name: text.income,
    type: 'bar',
    barGap: '0%',
    barCategoryGap: '28%',
    itemStyle: { color: colors.income, borderRadius: TOP_ROUNDED, ...border },
    data: income.map((value, i) =>
      i === topIncome
        ? { value, label: directLabel(theme, format.compact(value), 'top') }
        : { value },
    ),
  };
  const manualSeries: BarSeriesOption = {
    id: SERIES_IDS.manualExpense,
    name: text.manualExpense,
    type: 'bar',
    stack: 'expense',
    itemStyle: { color: colors.expense, ...border },
    data: points.map((p, i) => {
      const topSegment = p.estimatedCostSatang === 0;
      return {
        value: p.manualExpenseSatang,
        itemStyle: { borderRadius: topSegment ? TOP_ROUNDED : SQUARE },
        ...(topSegment && i === topExpense
          ? { label: directLabel(theme, format.compact(expense[i] ?? 0), 'top') }
          : {}),
      };
    }),
  };
  const estimateSeries: BarSeriesOption = {
    id: SERIES_IDS.estimatedCost,
    name: text.estimatedCost,
    type: 'bar',
    stack: 'expense',
    itemStyle: {
      color: colors.expense,
      decal: ESTIMATE_DECAL,
      borderRadius: TOP_ROUNDED,
      ...border,
    },
    data: points.map((p, i) =>
      p.estimatedCostSatang > 0 && i === topExpense
        ? {
            value: p.estimatedCostSatang,
            label: directLabel(theme, format.compact(expense[i] ?? 0), 'top'),
          }
        : { value: p.estimatedCostSatang },
    ),
  };

  const b = base(theme);
  return {
    ...b,
    legend: {
      ...b.legend,
      data: [text.income, text.manualExpense, text.estimatedCost],
    },
    tooltip: {
      ...b.tooltip,
      formatter: (params: unknown) => {
        const p = points[dataIndexOf(params)];
        if (p === undefined) return '';
        return [
          heading(format.bucketLong(p.bucket)),
          line(colors.income, text.income, format.money(incomeOf(p))),
          line(null, text.packageIncome, format.money(p.packageIncomeSatang), true),
          line(null, text.cashIncome, format.money(p.cashIncomeSatang), true),
          line(colors.expense, text.expenses, format.money(expenseOf(p))),
          line(null, text.manualExpense, format.money(p.manualExpenseSatang), true),
          line(null, text.estimatedCost, format.money(p.estimatedCostSatang), true),
        ].join('');
      },
    },
    xAxis: categoryAxis(
      theme,
      points.map((p) => format.bucketShort(p.bucket)),
    ),
    yAxis: valueAxis(theme, format.compact),
    series: [incomeSeries, manualSeries, estimateSeries],
  };
}

/**
 * (b) Profit per bucket (income − expenses): slot 1 bars up for a gain, critical red bars down
 * for a loss, two series of one stack so the legend names both ("ขาดทุน (−)"); the extremes get a
 * signed direct label.
 */
export function profitOption(
  points: readonly FinanceSeriesPoint[],
  theme: ChartTheme,
  text: ProfitText,
  format: ChartFormat,
): ChartOption {
  const { series: colors, tokens } = theme;
  const profit = points.map(bucketProfitOf);
  const best = indexOfMax(profit);
  const worst = indexOfMin(profit);
  const border = { borderColor: tokens.surface, borderWidth: 1 };
  const b = base(theme);
  return {
    ...b,
    legend: { ...b.legend, data: [text.profit, text.loss] },
    tooltip: {
      ...b.tooltip,
      formatter: (params: unknown) => {
        const i = dataIndexOf(params);
        const p = points[i];
        const value = profit[i] ?? 0;
        if (p === undefined) return '';
        return [
          heading(format.bucketLong(p.bucket)),
          line(
            value < 0 ? colors.critical : colors.income,
            value < 0 ? text.loss : text.profit,
            format.signed(value),
          ),
        ].join('');
      },
    },
    xAxis: categoryAxis(
      theme,
      points.map((p) => format.bucketShort(p.bucket)),
    ),
    yAxis: valueAxis(theme, format.compact),
    series: [
      {
        id: SERIES_IDS.profit,
        name: text.profit,
        type: 'bar',
        stack: 'profit',
        barCategoryGap: '28%',
        itemStyle: { color: colors.income, borderRadius: TOP_ROUNDED, ...border },
        data: profit.map((v, i) =>
          v >= 0
            ? i === best
              ? { value: v, label: directLabel(theme, format.signed(v), 'top') }
              : { value: v }
            : { value: '-' },
        ),
      },
      {
        id: SERIES_IDS.loss,
        name: text.loss,
        type: 'bar',
        stack: 'profit',
        itemStyle: { color: colors.critical, borderRadius: BOTTOM_ROUNDED, ...border },
        data: profit.map((v, i) =>
          v < 0
            ? i === worst
              ? { value: v, label: directLabel(theme, format.signed(v), 'bottom') }
              : { value: v }
            : { value: '-' },
        ),
      },
    ],
  };
}

export type PackageMixMeasure = 'orders' | 'income';

/** The mix sorted for the chart: largest first by the chosen measure. */
export function sortedMix(
  mix: readonly FinancePackageMix[],
  measure: PackageMixMeasure,
): FinancePackageMix[] {
  const of = (m: FinancePackageMix) => (measure === 'orders' ? m.orders : m.incomeSatang);
  return [...mix].sort((a, b) => of(b) - of(a) || a.code.localeCompare(b.code));
}

/** (c) Package mix: one slot-1 series of horizontal bars, largest on top, labelled at the top. */
export function packageMixOption(
  mix: readonly FinancePackageMix[],
  measure: PackageMixMeasure,
  theme: ChartTheme,
  text: PackageMixText,
  format: ChartFormat,
): ChartOption {
  const { series: colors, tokens } = theme;
  const rows = sortedMix(mix, measure);
  const values = rows.map((m) => (measure === 'orders' ? m.orders : m.incomeSatang));
  const show = (v: number) => (measure === 'orders' ? format.count(v) : format.compact(v));
  const top = indexOfMax(values);
  const b = base(theme);
  return {
    ...b,
    grid: { ...b.grid, top: 8, right: 48 },
    legend: { show: false },
    tooltip: {
      ...b.tooltip,
      formatter: (params: unknown) => {
        const m = rows[dataIndexOf(params)];
        if (m === undefined) return '';
        return [
          heading(m.name),
          line(measure === 'orders' ? colors.income : null, text.orders, format.count(m.orders)),
          line(
            measure === 'income' ? colors.income : null,
            text.income,
            format.money(m.incomeSatang),
          ),
        ].join('');
      },
    },
    yAxis: {
      ...categoryAxis(
        theme,
        rows.map((m) => m.name),
      ),
      inverse: true,
    },
    xAxis: {
      ...valueAxis(theme, show),
      ...(measure === 'orders' ? { minInterval: 1 } : {}),
    },
    series: [
      {
        id: SERIES_IDS.packageMix,
        name: measure === 'orders' ? text.orders : text.income,
        type: 'bar',
        barCategoryGap: '30%',
        itemStyle: {
          color: colors.income,
          borderRadius: RIGHT_ROUNDED,
          borderColor: tokens.surface,
          borderWidth: 1,
        },
        data: values.map((value, i) =>
          i === top ? { value, label: directLabel(theme, show(value), 'right') } : { value },
        ),
      },
    ],
  };
}
