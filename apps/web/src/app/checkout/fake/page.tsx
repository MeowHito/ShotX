import { PACKAGE_ORDER_COOKIE, parsePackageOrderCookie, PRODUCTION_APP_STAGE } from '@shotx/shared';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CheckoutReturnView } from '@/components/packages/checkout-return';
import { CheckoutShell } from '@/components/packages/checkout-shell';
import { FakeCheckout } from '@/components/packages/fake-checkout';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('checkout.fake');
  return { title: t('title'), robots: { index: false } };
}

/**
 * `/checkout/fake?order=<id>` (ADR 0026, PACKAGE_FAKE_CHECKOUT_PATH): the test gateway's page,
 * never on APP_STAGE=prod (the API refuses PACKAGE_GATEWAY=fake there too). Only the order in this
 * browser's cookie can be paid here.
 */
export default async function FakeCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.APP_STAGE === PRODUCTION_APP_STAGE) notFound();
  const { order: requested } = await searchParams;
  const order = parsePackageOrderCookie((await cookies()).get(PACKAGE_ORDER_COOKIE)?.value);
  const matches = order !== null && typeof requested === 'string' && requested === order.orderId;
  return (
    <CheckoutShell>
      {matches ? (
        <FakeCheckout orderId={order.orderId} />
      ) : (
        <CheckoutReturnView state={{ kind: 'notFound' }} />
      )}
    </CheckoutShell>
  );
}
