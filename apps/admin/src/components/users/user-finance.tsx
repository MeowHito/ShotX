'use client';

import { ADMIN_USER_FINANCE_MAX_ORDERS, type PackageOrderStatus } from '@shotx/shared';
import { Alert, cn, Skeleton } from '@shotx/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { intlLocale } from '@/i18n/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useUserFinance } from '@/lib/finance/queries';
import { useFormat } from '@/lib/i18n/use-format';
import { formatSignedSatang } from '@/lib/money';
import { Badge } from './users-table';

const STATUS_TONE: Record<PackageOrderStatus, 'neutral' | 'primary' | 'warning' | 'danger'> = {
  pending: 'warning',
  paid: 'primary',
  failed: 'neutral',
  amount_mismatch: 'danger',
};

function Card({
  label,
  value,
  tone,
  testId,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'loss';
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="min-w-0 space-y-1 rounded-xl border bg-background p-4 shadow-card"
      data-testid={testId}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'truncate text-xl font-semibold tabular-nums',
          tone === 'loss' && 'text-destructive',
        )}
      >
        {value}
      </p>
      {children !== undefined ? (
        <div className="space-y-0.5 text-xs text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * A photographer's money (ADR 0027 §4): purchases, what they paid (packages incl. VAT, cash, net
 * of VAT), the running cost allocated to them ("ประมาณการ", not a bill), the profit on the same
 * basis as the finance page (net + cash − estimate; red with a minus sign when a loss), usage, and
 * the order history. Read-only.
 */
export function UserFinance({ userId }: { userId: string }) {
  const t = useTranslations('userFinance');
  const tc = useTranslations('common');
  const format = useFormat();
  const locale = intlLocale(useLocale());
  const errorMessage = useErrorMessage();
  const query = useUserFinance(userId, true);

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="user-finance-title">
      <div className="space-y-1">
        <h2 id="user-finance-title" className="text-xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {query.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : query.isError ? (
        <Alert variant="destructive">
          {t('loadError')}: {errorMessage(query.error)}
        </Alert>
      ) : (
        (() => {
          const f = query.data;
          const loss = f.profitSatang < 0;
          return (
            <>
              <div
                aria-label={t('summaryLabel')}
                role="group"
                className="grid gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4"
              >
                <Card
                  testId="user-finance-purchases"
                  label={t('purchases')}
                  value={t('purchasesValue', { count: f.ordersPaid })}
                >
                  <p>
                    {f.firstPaidAt !== null && f.lastPaidAt !== null
                      ? t('firstLast', {
                          first: format.date(f.firstPaidAt),
                          last: format.date(f.lastPaidAt),
                        })
                      : t('neverPaid')}
                  </p>
                </Card>
                <Card
                  testId="user-finance-paid"
                  label={t('paid')}
                  value={format.satang(f.paidSatang + f.cashPaidSatang)}
                >
                  <p>{t('paidPackages', { amount: format.satang(f.paidSatang) })}</p>
                  <p>{t('paidCash', { amount: format.satang(f.cashPaidSatang) })}</p>
                  <p>{t('paidNet', { amount: format.satang(f.netPaidSatang) })}</p>
                </Card>
                <Card
                  testId="user-finance-cost"
                  label={t('cost')}
                  value={format.satang(f.estimatedCostSatang.total)}
                >
                  <p>
                    {t('costStorage', { amount: format.satang(f.estimatedCostSatang.storage) })}
                  </p>
                  <p>{t('costServer', { amount: format.satang(f.estimatedCostSatang.server) })}</p>
                </Card>
                <Card
                  testId="user-finance-profit"
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
                  value={formatSignedSatang(f.profitSatang, locale)}
                  tone={loss ? 'loss' : undefined}
                >
                  <p>{t('profitHint')}</p>
                </Card>
              </div>

              <div className="rounded-xl border bg-background px-5 py-3 shadow-card">
                <h3 className="py-1 text-sm font-semibold">{t('usage')}</h3>
                <dl className="grid gap-3 py-2 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('storage')}</dt>
                    <dd
                      className="font-medium tabular-nums"
                      title={format.bytes(f.usage.storageBytes)}
                    >
                      {format.gigabytes(f.usage.storageBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('bytesServed')}</dt>
                    <dd
                      className="font-medium tabular-nums"
                      title={format.bytes(f.usage.bytesServed)}
                    >
                      {format.gigabytes(f.usage.bytesServed)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('photos')}</dt>
                    <dd className="font-medium tabular-nums">
                      {format.count(f.usage.photosUploaded)}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="space-y-2">
                <h3 className="text-base font-semibold">{t('orders.title')}</h3>
                {f.orders.length === 0 ? (
                  <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                    {t('orders.empty')}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border bg-background shadow-card">
                    <table className="w-full min-w-[44rem] text-left text-sm">
                      <caption className="sr-only">{t('orders.tableLabel')}</caption>
                      <thead className="border-b bg-sidebar text-xs text-muted-foreground">
                        <tr>
                          <th scope="col" className="px-4 py-3 font-medium">
                            {t('orders.package')}
                          </th>
                          <th scope="col" className="px-4 py-3 font-medium">
                            {t('orders.status')}
                          </th>
                          <th scope="col" className="px-4 py-3 text-right font-medium">
                            {t('orders.total')}
                          </th>
                          <th scope="col" className="px-4 py-3 text-right font-medium">
                            {t('orders.vat')}
                          </th>
                          <th scope="col" className="px-4 py-3 font-medium">
                            {t('orders.created')}
                          </th>
                          <th scope="col" className="px-4 py-3 font-medium">
                            {t('orders.paid')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {f.orders.map((o) => (
                          <tr key={o.id}>
                            <td className="px-4 py-3 font-medium">{o.packageName}</td>
                            <td className="px-4 py-3">
                              <Badge tone={STATUS_TONE[o.status]}>
                                {t(`orderStatuses.${o.status}`)}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {format.satang(o.totalSatang)}
                            </td>
                            <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
                              {format.satang(o.vatSatang)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                              {format.dateTime(o.createdAt)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                              {o.paidAt !== null ? format.dateTime(o.paidAt) : tc('none')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {f.orders.length >= ADMIN_USER_FINANCE_MAX_ORDERS ? (
                  <p className="text-xs text-muted-foreground">
                    {t('orders.limited', { max: ADMIN_USER_FINANCE_MAX_ORDERS })}
                  </p>
                ) : null}
              </div>
            </>
          );
        })()
      )}
    </section>
  );
}
