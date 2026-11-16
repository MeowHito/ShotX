'use client';

import { FINANCE_TOP_CUSTOMERS, type FinanceTopCustomer } from '@shotx/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { userDetailHref } from '@/components/users/users-table';
import { useFormat } from '@/lib/i18n/use-format';

/** The range's top customers (paid orders + cash), each linking to their user page. */
export function TopCustomers({ customers }: { customers: readonly FinanceTopCustomer[] }) {
  const t = useTranslations('topCustomers');
  const format = useFormat();
  return (
    <section
      aria-labelledby="top-customers-title"
      className="min-w-0 space-y-3 rounded-2xl border bg-background p-4 shadow-card sm:p-5"
    >
      <div className="space-y-0.5">
        <h2 id="top-customers-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('description', { max: FINANCE_TOP_CUSTOMERS })}
        </p>
      </div>
      {customers.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="sr-only">{t('tableLabel')}</caption>
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('customer')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('orders')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('paid')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers.map((c) => (
                <tr key={c.userId}>
                  <td className="px-3 py-2">
                    <Link
                      href={userDetailHref(c.userId)}
                      className="font-medium break-all underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {c.email ?? c.name ?? c.userId}
                    </Link>
                    {c.email !== null ? (
                      <div className="text-xs text-muted-foreground">{c.name ?? t('noName')}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{format.count(c.orders)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {format.satang(c.paidSatang)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
