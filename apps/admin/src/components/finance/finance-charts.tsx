'use client';

import type { FinanceResponse } from '@shotx/shared';
import { Button, cn } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { ChartCard, DataTable } from '@/components/charts/chart-card';
import { EChart } from '@/components/charts/echart';
import { useChartTheme } from '@/lib/charts/theme';
import {
  bucketProfitOf,
  expenseOf,
  incomeExpenseOption,
  incomeOf,
  packageMixOption,
  type PackageMixMeasure,
  profitOption,
  sortedMix,
} from '@/lib/finance/charts';
import { useChartFormat } from '@/lib/finance/use-chart-format';

/** (a) income vs expenses, (b) profit per bucket, (c) package mix; each with a table view. */
export function FinanceCharts({ data }: { data: FinanceResponse }) {
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <div className="min-w-0 xl:col-span-2">
        <IncomeExpenseChart data={data} />
      </div>
      <ProfitChart data={data} />
      <PackageMixChart data={data} />
    </div>
  );
}

function IncomeExpenseChart({ data }: { data: FinanceResponse }) {
  const t = useTranslations('charts');
  const theme = useChartTheme();
  const format = useChartFormat();
  const text = useMemo(
    () => ({
      income: t('incomeExpense.income'),
      manualExpense: t('incomeExpense.manualExpense'),
      estimatedCost: t('incomeExpense.estimatedCost'),
      packageIncome: t('incomeExpense.packageIncome'),
      cashIncome: t('incomeExpense.cashIncome'),
      expenses: t('incomeExpense.expenses'),
    }),
    [t],
  );
  const option = useMemo(
    () => incomeExpenseOption(data.series, theme, text, format),
    [data.series, theme, text, format],
  );
  return (
    <ChartCard
      title={t('incomeExpense.title')}
      description={t('incomeExpense.description')}
      chart={() => <EChart option={option} label={t('incomeExpense.title')} height={320} />}
      table={() => (
        <DataTable
          caption={t('incomeExpense.title')}
          head={[
            t('bucket'),
            text.income,
            text.packageIncome,
            text.cashIncome,
            text.expenses,
            text.manualExpense,
            text.estimatedCost,
          ]}
          rows={data.series.map((p) => ({
            key: p.bucket,
            cells: [
              format.bucketLong(p.bucket),
              format.money(incomeOf(p)),
              format.money(p.packageIncomeSatang),
              format.money(p.cashIncomeSatang),
              format.money(expenseOf(p)),
              format.money(p.manualExpenseSatang),
              format.money(p.estimatedCostSatang),
            ],
          }))}
        />
      )}
    />
  );
}

function ProfitChart({ data }: { data: FinanceResponse }) {
  const t = useTranslations('charts');
  const theme = useChartTheme();
  const format = useChartFormat();
  const text = useMemo(() => ({ profit: t('profit.profit'), loss: t('profit.loss') }), [t]);
  const option = useMemo(
    () => profitOption(data.series, theme, text, format),
    [data.series, theme, text, format],
  );
  return (
    <ChartCard
      title={t('profit.title')}
      description={t('profit.description')}
      chart={() => <EChart option={option} label={t('profit.title')} />}
      table={() => (
        <DataTable
          caption={t('profit.title')}
          head={[t('bucket'), t('profit.value')]}
          rows={data.series.map((p) => {
            const value = bucketProfitOf(p);
            return {
              key: p.bucket,
              cells: [
                format.bucketLong(p.bucket),
                <span key="v" className={cn(value < 0 && 'font-medium text-destructive')}>
                  {format.signed(value)}
                </span>,
              ],
            };
          })}
        />
      )}
    />
  );
}

function PackageMixChart({ data }: { data: FinanceResponse }) {
  const t = useTranslations('charts');
  const theme = useChartTheme();
  const format = useChartFormat();
  const [measure, setMeasure] = useState<PackageMixMeasure>('orders');
  const text = useMemo(() => ({ orders: t('mix.orders'), income: t('mix.income') }), [t]);
  const option = useMemo(
    () => packageMixOption(data.packageMix, measure, theme, text, format),
    [data.packageMix, measure, theme, text, format],
  );
  const rows = sortedMix(data.packageMix, measure);
  const empty = rows.length === 0;
  return (
    <ChartCard
      title={t('mix.title')}
      description={t('mix.description')}
      controls={
        <div role="group" aria-label={t('mix.measure')} className="flex rounded-lg border p-0.5">
          {(['orders', 'income'] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={measure === m ? 'default' : 'ghost'}
              aria-pressed={measure === m}
              className="h-8"
              onClick={() => setMeasure(m)}
            >
              {m === 'orders' ? text.orders : text.income}
            </Button>
          ))}
        </div>
      }
      chart={() =>
        empty ? (
          <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            {t('mix.empty')}
          </p>
        ) : (
          <EChart
            option={option}
            label={t('mix.title')}
            height={Math.max(160, 48 * rows.length + 32)}
          />
        )
      }
      table={() => (
        <DataTable
          caption={t('mix.title')}
          head={[t('mix.package'), text.orders, text.income]}
          rows={rows.map((m) => ({
            key: m.code,
            cells: [m.name, format.count(m.orders), format.money(m.incomeSatang)],
          }))}
        />
      )}
    />
  );
}
