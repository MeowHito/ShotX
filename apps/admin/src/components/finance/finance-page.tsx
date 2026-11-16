'use client';

import {
  FINANCE_BUCKETS,
  type FinanceBucket,
  financeMaxDays,
  type FinanceTotals,
} from '@shotx/shared';
import { Alert, Button, cn, Input, Label, Skeleton } from '@shotx/ui';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { intlLocale } from '@/i18n/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { todayInBangkok } from '@/lib/format';
import { useFinance } from '@/lib/finance/queries';
import {
  FINANCE_PRESETS,
  type FinancePreset,
  type FinanceSelection,
  formatBucket,
  type RangeProblem,
  rangeProblem,
  selectPreset,
} from '@/lib/finance/range';
import { useFormat } from '@/lib/i18n/use-format';
import { formatSignedSatang } from '@/lib/money';
import { ExpensesLedger } from './expenses-ledger';
import { FinanceCharts } from './finance-charts';
import { TopCustomers } from './top-customers';

/**
 * "การเงิน" (ADR 0027 §5): a range and bucket filter, stat tiles, income vs expenses, profit,
 * package mix (each with a table view), the top customers and the expenses ledger. Reads
 * GET /admin/finance (rollups of orders, cash payments and expenses; never activity_events).
 * Read-only figures: there is no plan or checkout UI here (BILLING_MODE=offline).
 */
export function FinancePage({ today: todayProp }: { today?: string } = {}) {
  const t = useTranslations('finance');
  const errorMessage = useErrorMessage();
  const locale = intlLocale(useLocale());
  const [today] = useState(() => todayProp ?? todayInBangkok());
  const [selection, setSelection] = useState<FinanceSelection>(() => selectPreset('30d', today));
  const query = useFinance({
    from: selection.from,
    to: selection.to,
    bucket: selection.bucket,
  });
  const data = query.data;

  return (
    <div className="min-w-0 space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('lead')}</p>
        {data !== undefined ? (
          <p className="text-sm font-medium" data-testid="finance-range">
            {t('range', {
              from: formatBucket(data.range.from, locale, 'long'),
              to: formatBucket(data.range.to, locale, 'long'),
            })}
          </p>
        ) : null}
      </header>

      <FinanceFilters today={today} selection={selection} onChange={setSelection} />

      {query.isError ? (
        <Alert variant="destructive">
          {t('loadError')}: {errorMessage(query.error)}
        </Alert>
      ) : null}

      {data === undefined ? (
        query.isPending ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-80 w-full rounded-2xl" />
          </div>
        ) : null
      ) : (
        <div className={cn('min-w-0 space-y-5', query.isPlaceholderData && 'opacity-70')}>
          <StatTiles totals={data.totals} />
          <FinanceCharts data={data} />
          <TopCustomers customers={data.topCustomers} />
        </div>
      )}

      <ExpensesLedger range={{ from: selection.from, to: selection.to }} today={today} />
    </div>
  );
}

function FinanceFilters({
  today,
  selection,
  onChange,
}: {
  today: string;
  selection: FinanceSelection;
  onChange: (next: FinanceSelection) => void;
}) {
  const t = useTranslations('finance.filters');
  const id = useId();
  const [custom, setCustom] = useState(selection.preset === 'custom');
  const [from, setFrom] = useState(selection.from);
  const [to, setTo] = useState(selection.to);
  const [problem, setProblem] = useState<RangeProblem | null>(null);
  const [problemBucket, setProblemBucket] = useState<FinanceBucket>(selection.bucket);

  function pick(preset: FinancePreset) {
    setProblem(null);
    if (preset === 'custom') {
      setCustom(true);
      setFrom(selection.from);
      setTo(selection.to);
      return;
    }
    setCustom(false);
    onChange(selectPreset(preset, today));
  }

  function applyCustom(event: FormEvent) {
    event.preventDefault();
    const found = rangeProblem(from, to, selection.bucket);
    setProblem(found);
    setProblemBucket(selection.bucket);
    if (found === null) onChange({ preset: 'custom', from, to, bucket: selection.bucket });
  }

  function pickBucket(bucket: FinanceBucket) {
    const found = rangeProblem(selection.from, selection.to, bucket);
    setProblem(found);
    setProblemBucket(bucket);
    if (found === null) onChange({ ...selection, bucket });
  }

  const active = custom ? 'custom' : selection.preset;

  return (
    <div
      role="group"
      aria-label={t('label')}
      className="flex flex-wrap items-end gap-3 rounded-xl border bg-sidebar p-3"
    >
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('label')}>
        {FINANCE_PRESETS.map((preset) => (
          <Button
            key={preset}
            size="sm"
            variant={active === preset ? 'default' : 'outline'}
            aria-pressed={active === preset}
            onClick={() => pick(preset)}
          >
            {t(`presets.${preset}`)}
          </Button>
        ))}
      </div>
      {custom ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={applyCustom} noValidate>
          <div className="space-y-1">
            <Label htmlFor={`${id}-from`}>{t('from')}</Label>
            <Input
              id={`${id}-from`}
              type="date"
              max={today}
              value={from}
              className="h-9 w-40"
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-to`}>{t('to')}</Label>
            <Input
              id={`${id}-to`}
              type="date"
              max={today}
              value={to}
              className="h-9 w-40"
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" variant="outline">
            {t('apply')}
          </Button>
        </form>
      ) : null}
      <div className="flex items-center gap-2 sm:ml-auto">
        <span className="text-sm text-muted-foreground" id={`${id}-bucket`}>
          {t('bucket')}
        </span>
        <div role="group" aria-labelledby={`${id}-bucket`} className="flex rounded-lg border p-0.5">
          {FINANCE_BUCKETS.map((bucket) => (
            <Button
              key={bucket}
              size="sm"
              className="h-8"
              variant={selection.bucket === bucket ? 'default' : 'ghost'}
              aria-pressed={selection.bucket === bucket}
              onClick={() => pickBucket(bucket)}
            >
              {t(`buckets.${bucket}`)}
            </Button>
          ))}
        </div>
      </div>
      {problem !== null ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {problem === 'too_long'
            ? t('problems.too_long', { max: financeMaxDays(problemBucket) })
            : t(`problems.${problem}`)}
        </p>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'loss';
  testId: string;
}) {
  return (
    <div
      className="min-w-0 space-y-1 rounded-2xl border bg-background p-4 shadow-card"
      data-testid={testId}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'truncate text-xl font-semibold tabular-nums sm:text-2xl',
          tone === 'loss' && 'text-destructive',
        )}
      >
        {value}
      </p>
      {sub !== undefined ? (
        <div className="space-y-0.5 text-xs text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

export function StatTiles({ totals }: { totals: FinanceTotals }) {
  const t = useTranslations('finance.tiles');
  const format = useFormat();
  const locale = intlLocale(useLocale());
  const loss = totals.profitSatang < 0;
  return (
    <section
      aria-label={t('label')}
      className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6"
    >
      <Tile
        testId="tile-income"
        label={
          <>
            {t('income')} <span className="opacity-80">({t('incomeHint')})</span>
          </>
        }
        value={format.satang(totals.incomeSatang)}
        sub={
          <>
            <p>{t('incomeNet', { amount: format.satang(totals.netIncomeSatang) })}</p>
            <p>
              {t('incomeSplit', {
                packages: format.satang(totals.packageIncomeSatang),
                cash: format.satang(totals.cashIncomeSatang),
              })}
            </p>
          </>
        }
      />
      <Tile
        testId="tile-expense"
        label={t('expense')}
        value={format.satang(totals.expenseSatang)}
        sub={
          <p>
            {t('expenseSplit', {
              manual: format.satang(totals.manualExpenseSatang),
              estimated: format.satang(totals.estimatedCostSatang),
            })}
          </p>
        }
      />
      <Tile
        testId="tile-profit"
        label={
          <>
            {t('profit')}
            {loss ? (
              <span className="ml-1.5 rounded-md bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
                {t('loss')}
              </span>
            ) : null}
          </>
        }
        value={formatSignedSatang(totals.profitSatang, locale)}
        tone={loss ? 'loss' : undefined}
        sub={<p>{t('profitHint')}</p>}
      />
      <Tile
        testId="tile-orders"
        label={t('ordersPaid')}
        value={format.count(totals.ordersPaid)}
        sub={<p>{t('paidSignups', { count: totals.paidSignups })}</p>}
      />
      <Tile
        testId="tile-buyers"
        label={t('buyers')}
        value={format.count(totals.buyers)}
        sub={<p>{t('buyersHint')}</p>}
      />
      <Tile
        testId="tile-free"
        label={t('freeSignups')}
        value={format.count(totals.freeSignups)}
        sub={<p>{t('freeSignupsHint')}</p>}
      />
    </section>
  );
}
