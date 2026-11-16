'use client';

import { Button } from '@shotx/ui';
import { ChartColumnIcon, TableIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useId, useState } from 'react';

/**
 * A chart in a card with a "ดูเป็นตาราง" toggle: the same numbers as a table (exact values,
 * screen readers, small screens). `chart` and `table` are render functions, so the hidden view
 * isn't mounted. `controls` sit next to the toggle (e.g. the package mix measure).
 */
export function ChartCard({
  title,
  description,
  controls,
  footnote,
  chart,
  table,
}: {
  title: string;
  description?: string;
  controls?: ReactNode;
  footnote?: ReactNode;
  chart: () => ReactNode;
  table: () => ReactNode;
}) {
  const t = useTranslations('charts');
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-3 rounded-2xl border bg-background p-4 shadow-card sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h2 id={`${id}-title`} className="text-base font-semibold">
            {title}
          </h2>
          {description !== undefined ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {controls}
          <Button
            variant="outline"
            size="sm"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? <ChartColumnIcon aria-hidden /> : <TableIcon aria-hidden />}
            {asTable ? t('showChart') : t('showTable')}
          </Button>
        </div>
      </div>
      {asTable ? <div className="overflow-x-auto">{table()}</div> : chart()}
      {footnote !== undefined ? <p className="text-xs text-muted-foreground">{footnote}</p> : null}
    </section>
  );
}

/** A compact data table for chart cards (first column the label, numbers right-aligned). */
export function DataTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <table className="w-full min-w-[28rem] text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="border-b text-xs text-muted-foreground">
        <tr>
          {head.map((h, i) => (
            <th
              key={h}
              scope="col"
              className={i === 0 ? 'px-3 py-2 font-medium' : 'px-3 py-2 text-right font-medium'}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((row) => (
          <tr key={row.key}>
            {row.cells.map((cell, i) => (
              <td
                key={i}
                className={
                  i === 0
                    ? 'px-3 py-2 whitespace-nowrap'
                    : 'px-3 py-2 text-right whitespace-nowrap tabular-nums'
                }
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
