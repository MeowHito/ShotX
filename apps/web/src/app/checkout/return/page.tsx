import {
  loadPackagesWebConfig,
  PACKAGE_ORDER_COOKIE,
  parsePackageOrderCookie,
} from '@shotx/shared';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { CheckoutReturn } from '@/components/packages/checkout-return';
import { CheckoutShell } from '@/components/packages/checkout-shell';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('checkout');
  return { title: t('title'), robots: { index: false } };
}

/**
 * `/checkout/return` (ADR 0026, PACKAGE_CHECKOUT_RETURN_PATH): where the gateway sends the buyer
 * back. The order cookie is read here on the server (only whether there is one reaches the
 * browser); the status is polled through GET /checkout/order.
 */
export default async function CheckoutReturnPage() {
  const order = parsePackageOrderCookie((await cookies()).get(PACKAGE_ORDER_COOKIE)?.value);
  const { orderPoll } = loadPackagesWebConfig(process.env);
  return (
    <CheckoutShell>
      <CheckoutReturn
        hasOrder={order !== null}
        intervalMs={orderPoll.intervalSeconds * 1000}
        timeoutMs={orderPoll.timeoutSeconds * 1000}
      />
    </CheckoutShell>
  );
}
