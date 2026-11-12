'use client';

import type { CheckoutResponse, PaymentView } from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { CheckCircle2Icon, CreditCardIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { isPaymentFinal, useInvalidateBilling, usePayment } from '@/lib/billing/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFormatSatang } from '@/lib/i18n/use-format';
import { PromptPayQr } from './qr-code';

/** The final outcome of a payment, as a message key under `billing.payment`. */
export function paymentOutcome(
  payment: PaymentView,
): 'paid' | 'unapplied' | 'expired' | 'failed' | 'refunded' | null {
  if (!isPaymentFinal(payment)) return null;
  if (payment.status === 'paid')
    return payment.checkout?.status === 'failed' ? 'unapplied' : 'paid';
  if (payment.status === 'refunded') return 'refunded';
  if (payment.status === 'failed') return 'failed';
  // Pending at the gateway but the checkout expired, or the QR timed out.
  return payment.checkout?.status === 'failed' ? 'failed' : 'expired';
}

/**
 * One payment being paid: the PromptPay QR (the gateway's image from the checkout response, else
 * drawn from the payload) or a link back to the card page, polled with GET /billing/payments/:id
 * until it is paid, failed or expired. Card numbers are only ever typed on the gateway's page.
 */
export function PaymentPanel({
  paymentId,
  pollIntervalMs,
  checkout,
  redirect,
  onStartOver,
  onDone,
}: {
  paymentId: string;
  pollIntervalMs: number;
  /** The checkout response that created it (has the gateway's QR image), if this page made it. */
  checkout?: CheckoutResponse;
  redirect: (url: string) => void;
  onStartOver: () => void;
  onDone: () => void;
}) {
  const formatSatang = useFormatSatang();
  const t = useTranslations('billing.payment');
  const describe = useErrorMessage();
  const format = useFormatter();
  const payment = usePayment(paymentId, pollIntervalMs);
  const invalidate = useInvalidateBilling();
  const outcome = payment.data === undefined ? null : paymentOutcome(payment.data);
  const settled = useRef(false);

  useEffect(() => {
    if (outcome === 'paid' && !settled.current) {
      settled.current = true;
      void invalidate();
    }
  }, [outcome, invalidate]);

  if (payment.isError && payment.data === undefined) {
    return (
      <Alert variant="destructive" className="flex items-center justify-between gap-2">
        <span>{describe(payment.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void payment.refetch()}>
          {t('startOver')}
        </Button>
      </Alert>
    );
  }
  const view = payment.data;
  const amount = view?.amount ?? checkout?.amount;
  const action =
    view === undefined ? (checkout?.action ?? null) : outcome === null ? view.action : null;
  // The gateway's image only exists in the creation response.
  const image =
    checkout?.action?.kind === 'promptpay' && checkout.paymentId === paymentId
      ? checkout.action.qrImageDataUrl
      : null;
  const changeType = view?.checkout?.changeType ?? checkout?.changeType;
  const effectiveAt = checkout?.effectiveAt;

  if (outcome !== null) {
    const ok = outcome === 'paid';
    return (
      <section className="space-y-4 rounded-xl border p-4" aria-live="polite">
        <div role="status" className="flex items-start gap-2">
          {ok ? (
            <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-green-600" aria-hidden />
          ) : null}
          <p className="font-medium">
            {ok && changeType === 'downgrade' && effectiveAt !== undefined
              ? t('downgradeScheduled', {
                  date: format.dateTime(new Date(effectiveAt), { dateStyle: 'medium' }),
                })
              : t(outcome)}
          </p>
        </div>
        {ok ? (
          <Button onClick={onDone}>{t('done')}</Button>
        ) : (
          <Button onClick={onStartOver}>{t('startOver')}</Button>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border p-4">
      {amount !== undefined ? (
        <div className="space-y-1 text-center">
          <p className="text-2xl font-bold">
            {t('amount', { amount: formatSatang(amount.totalSatang) })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('vat', { vat: formatSatang(amount.vatSatang) })}
          </p>
          {checkout?.proration ? (
            <p className="text-xs text-muted-foreground">
              {t('proration', { days: checkout.proration.remainingDays })}
            </p>
          ) : null}
        </div>
      ) : null}
      {action?.kind === 'promptpay' ? (
        <div className="space-y-3">
          <h2 className="text-center font-semibold">{t('qrHeading')}</h2>
          <PromptPayQr
            payload={action.qrPayload}
            imageDataUrl={image}
            label={t('qrAlt', { amount: amount ? formatSatang(amount.totalSatang) : '' })}
          />
          <p className="text-center text-sm text-muted-foreground">
            {t('qrExpires', {
              time: format.dateTime(new Date(action.expiresAt), { timeStyle: 'short' }),
            })}
          </p>
          <p className="text-center text-xs text-muted-foreground">{t('qrHint')}</p>
        </div>
      ) : null}
      {action?.kind === 'card_redirect' ? (
        <Button size="lg" className="w-full" onClick={() => redirect(action.redirectUrl)}>
          <CreditCardIcon aria-hidden />
          {t('resume')}
        </Button>
      ) : null}
      <p role="status" className="text-center text-sm">
        {view === undefined ? t('status.pending') : t('waiting')}
      </p>
    </section>
  );
}
