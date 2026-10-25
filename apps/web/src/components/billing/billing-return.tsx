'use client';

import { idSchema } from '@shotx/shared';
import { Alert, buttonVariants } from '@shotx/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BILLING_HREF } from '@/components/drive/paths';
import { PaymentPanel } from './payment-panel';

/**
 * `/studio/billing/return?payment={id}` (BILLING_CARD_RETURN_PATH): where the gateway's card page
 * sends the browser back. The return itself proves nothing, so the page polls
 * GET /billing/payments/:id until the webhook has settled it.
 */
export function BillingReturn({
  paymentId,
  pollIntervalMs,
  navigate = (url) => window.location.assign(url),
}: {
  paymentId: string | null;
  pollIntervalMs: number;
  navigate?: (url: string) => void;
}) {
  const t = useTranslations('billing');
  const valid = paymentId !== null && idSchema.safeParse(paymentId).success;
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">{t('return.title')}</h1>
      {valid ? (
        <PaymentPanel
          paymentId={paymentId}
          pollIntervalMs={pollIntervalMs}
          redirect={navigate}
          onStartOver={() => navigate(BILLING_HREF)}
          onDone={() => navigate(BILLING_HREF)}
        />
      ) : (
        <>
          <Alert variant="destructive">{t('return.missing')}</Alert>
          <Link href={BILLING_HREF} className={buttonVariants()}>
            {t('payment.done')}
          </Link>
        </>
      )}
    </div>
  );
}
