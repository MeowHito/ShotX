import {
  loadPackagesWebConfig,
  PACKAGE_ORDER_COOKIE,
  parsePackageOrderCookie,
} from '@shotx/shared';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { CheckoutReturnView } from '@/components/packages/checkout-return';
import { CheckoutShell } from '@/components/packages/checkout-shell';
import { PayCheckout } from '@/components/packages/pay-checkout';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('checkout.pay');
  return { title: t('title'), robots: { index: false } };
}

/**
 * `/checkout/pay?order=<id>` (ADR 0029, PACKAGE_PAY_PATH): Snap's own pay page for mPAY. Only the
 * order in this browser's cookie can be paid here (`order`, when given, must be it).
 */
export default async function PayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { order: requested } = await searchParams;
  const order = parsePackageOrderCookie((await cookies()).get(PACKAGE_ORDER_COOKIE)?.value);
  const matches = order !== null && (requested === undefined || requested === order.orderId);
  const { orderPoll } = loadPackagesWebConfig(process.env);
  return (
    <CheckoutShell>
      {matches ? (
        <PayCheckout orderId={order.orderId} intervalMs={orderPoll.intervalSeconds * 1000} />
      ) : (
        <CheckoutReturnView state={{ kind: 'notFound' }} />
      )}
    </CheckoutShell>
  );
}
