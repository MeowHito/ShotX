'use client';

import {
  checkoutPendingDetailsSchema,
  type CheckoutPaymentBody,
  type CheckoutResponse,
  ErrorCode,
  type PlansResponse,
  type PublicPlan,
  type SubscriptionView,
} from '@shotx/shared';
import { Alert, Button, cn } from '@shotx/ui';
import { ArrowLeftIcon, CheckIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { isApiError } from '@/lib/api/errors';
import { changeTypeFor, useCheckout, useInvalidateBilling } from '@/lib/billing/queries';
import { newIdempotencyKey } from '@/lib/downloads/downloads';
import { useErrorMessage, useNoticeMessage } from '@/lib/errors/use-error-message';
import { useFormatBytes, useFormatSatang } from '@/lib/i18n/use-format';
import { PaymentPanel } from './payment-panel';

type Method = 'promptpay' | 'card';

/** A radio option row (native inputs: big tap targets, no extra dependency). */
function Choice({
  name,
  checked,
  disabled,
  onSelect,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm',
        checked && 'border-primary bg-primary/5',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 size-4 accent-primary"
      />
      <span className="space-y-0.5">
        <span className="block font-medium">{label}</span>
        {hint !== undefined ? (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

/** The plan cards to pick from, the current one marked. */
export function PlanPicker({
  plans,
  subscription,
  onSelect,
}: {
  plans: PlansResponse;
  subscription: SubscriptionView | null;
  onSelect: (plan: PublicPlan) => void;
}) {
  const formatBytes = useFormatBytes();
  const formatSatang = useFormatSatang();
  const t = useTranslations('billing');
  const tp = useTranslations('pricing');
  const blocked = subscription?.pendingChange != null && subscription.status === 'active';
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t('plans.heading')}</h2>
      {blocked ? <Alert variant="warning">{t('plans.pendingBlocked')}</Alert> : null}
      <ul className="grid gap-3 sm:grid-cols-2" aria-label={tp('listLabel')}>
        {plans.plans.map((plan) => {
          const current = subscription?.plan.code === plan.code;
          return (
            <li key={plan.code} className="flex flex-col gap-2 rounded-xl border p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold">{plan.name}</h3>
                {current ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                    {t('plans.current')}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">
                {tp('storage', { quota: formatBytes(plan.quotaBytes) })}
              </p>
              <p className="text-sm">
                {tp('perMonth', { price: formatSatang(plan.month.totalSatang) })}
                <span className="text-muted-foreground">
                  {' · '}
                  {tp('perYear', { price: formatSatang(plan.year.totalSatang) })}
                </span>
              </p>
              <Button
                className="mt-auto"
                variant={current ? 'outline' : 'default'}
                disabled={blocked}
                onClick={() => onSelect(plan)}
              >
                {t('plans.select', { plan: plan.name })}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t('checkout.pricesIncludeVat')}</p>
    </section>
  );
}

type Stage =
  | { kind: 'configure' }
  | { kind: 'paying'; paymentId: string; checkout?: CheckoutResponse }
  | { kind: 'completed'; checkout: CheckoutResponse }
  | { kind: 'redirecting' };

/**
 * Checkout of one plan: what the change does (upgrade now with proration; downgrade at period
 * end, uploads blocked while over quota, files never deleted), how to pay (PromptPay prepaid
 * months, or a card on the gateway's page that then renews automatically), then the payment.
 * Every click on "pay" sends a fresh Idempotency-Key.
 */
export function CheckoutFlow({
  plan,
  plans,
  subscription,
  pollIntervalMs,
  redirect,
  onBack,
}: {
  plan: PublicPlan;
  plans: PlansResponse;
  subscription: SubscriptionView | null;
  pollIntervalMs: number;
  redirect: (url: string) => void;
  onBack: () => void;
}) {
  const formatSatang = useFormatSatang();
  const t = useTranslations('billing');
  const describe = useErrorMessage();
  const noticeText = useNoticeMessage();
  const format = useFormatter();
  const checkout = useCheckout();
  const invalidate = useInvalidateBilling();
  const changeType = changeTypeFor(subscription, plans.plans, plan);
  const autoRenewOn = subscription?.billing === 'auto_renew';
  const cardBlocked =
    changeType === 'renew' && autoRenewOn && subscription?.status === 'active'
      ? t('checkout.cardUnavailableRenew')
      : changeType === 'downgrade' && !autoRenewOn
        ? t('checkout.cardUnavailableDowngrade')
        : null;

  const [method, setMethod] = useState<Method>('promptpay');
  const [months, setMonths] = useState<number>(plans.prepaidMonths[0] ?? 1);
  const [renewInterval, setRenewInterval] = useState<1 | 12>(plans.autoRenewMonths[0] ?? 1);
  const [stage, setStage] = useState<Stage>({ kind: 'configure' });
  const [error, setError] = useState<string | null>(null);
  const [pendingPaymentId, setPendingPaymentId] = useState<string | null>(null);

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const effectiveMethod: Method = cardBlocked !== null ? 'promptpay' : method;

  async function pay() {
    setError(null);
    setPendingPaymentId(null);
    const payment: CheckoutPaymentBody =
      effectiveMethod === 'card'
        ? { method: 'card', months: renewInterval }
        : { method: 'promptpay', months: changeType === 'upgrade' ? null : months };
    try {
      const res = await checkout.mutateAsync({
        planCode: plan.code,
        changeType,
        payment,
        idempotencyKey: newIdempotencyKey(),
      });
      if (res.paymentId === null || res.action === null) {
        setStage({ kind: 'completed', checkout: res });
      } else if (res.action.kind === 'card_redirect') {
        setStage({ kind: 'redirecting' });
        redirect(res.action.redirectUrl);
      } else {
        setStage({ kind: 'paying', paymentId: res.paymentId, checkout: res });
      }
    } catch (err) {
      setError(describe(err));
      if (isApiError(err, ErrorCode.CHECKOUT_PENDING)) {
        const details = checkoutPendingDetailsSchema.safeParse(err.details);
        if (details.success && details.data.paymentId !== null) {
          setPendingPaymentId(details.data.paymentId);
        }
      }
      // The state changed under us (another tab, the daily job): show the fresh state.
      if (isApiError(err, ErrorCode.PLAN_CHANGE_INVALID)) void invalidate();
    }
  }

  const heading = t('checkout.heading', {
    change: t(`checkout.changeTypes.${changeType}`),
    plan: plan.name,
  });

  if (stage.kind === 'paying') {
    return (
      <section className="space-y-4" aria-label={heading}>
        <h2 className="text-lg font-semibold">{heading}</h2>
        {stage.checkout?.notices.map((n) => (
          <Alert key={n.code} variant="warning">
            {noticeText(n)}
          </Alert>
        ))}
        <PaymentPanel
          paymentId={stage.paymentId}
          pollIntervalMs={pollIntervalMs}
          checkout={stage.checkout}
          redirect={redirect}
          onStartOver={() => setStage({ kind: 'configure' })}
          onDone={onBack}
        />
      </section>
    );
  }
  if (stage.kind === 'redirecting') {
    return (
      <p role="status" className="py-10 text-center text-muted-foreground">
        {t('payment.redirecting')}
      </p>
    );
  }
  if (stage.kind === 'completed') {
    const res = stage.checkout;
    return (
      <section className="space-y-4 rounded-xl border p-4" aria-label={heading}>
        <p role="status" className="flex items-start gap-2 font-medium">
          <CheckIcon className="mt-0.5 size-5 shrink-0 text-green-600" aria-hidden />
          {res.changeType === 'downgrade'
            ? t('payment.downgradeScheduled', { date: date(res.effectiveAt) })
            : res.changeType === 'upgrade'
              ? t('payment.completedFree')
              : t('payment.completed')}
        </p>
        {res.notices.map((n) => (
          <Alert key={n.code} variant="warning">
            {noticeText(n)}
          </Alert>
        ))}
        <Button onClick={onBack}>{t('payment.done')}</Button>
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-label={heading}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('checkout.back')}>
          <ArrowLeftIcon aria-hidden />
        </Button>
        <h2 className="text-lg font-semibold">{heading}</h2>
      </div>

      <Alert>
        {changeType === 'downgrade'
          ? t('checkout.explain.downgrade', { date: date(subscription?.periodEnd ?? '') })
          : t(`checkout.explain.${changeType}`)}
      </Alert>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">{t('checkout.method')}</legend>
        <Choice
          name="method"
          checked={effectiveMethod === 'promptpay'}
          onSelect={() => setMethod('promptpay')}
          label={t('checkout.promptpay')}
          hint={t('checkout.promptpayHint')}
        />
        <Choice
          name="method"
          checked={effectiveMethod === 'card'}
          disabled={cardBlocked !== null}
          onSelect={() => setMethod('card')}
          label={t('checkout.card')}
          hint={cardBlocked ?? t('checkout.cardHint')}
        />
      </fieldset>

      {effectiveMethod === 'promptpay' ? (
        changeType === 'upgrade' ? (
          <p className="text-sm text-muted-foreground">{t('checkout.upgradeAmount')}</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{t('checkout.months')}</legend>
            {plan.prepaid.map((option) => (
              <Choice
                key={option.months}
                name="months"
                checked={months === option.months}
                onSelect={() => setMonths(option.months)}
                label={t('checkout.monthsOption', {
                  months: option.months,
                  price: formatSatang(option.amount.totalSatang),
                })}
              />
            ))}
          </fieldset>
        )
      ) : (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t('checkout.interval')}</legend>
          {plans.autoRenewMonths.map((m) => (
            <Choice
              key={m}
              name="interval"
              checked={renewInterval === m}
              onSelect={() => setRenewInterval(m)}
              label={t('checkout.intervalOption', {
                months: m,
                price: formatSatang((m === 12 ? plan.year : plan.month).totalSatang),
              })}
            />
          ))}
          {changeType === 'downgrade' ? (
            <p className="text-xs text-muted-foreground">{t('checkout.cardDowngradeNote')}</p>
          ) : null}
          {changeType === 'upgrade' ? (
            <p className="text-xs text-muted-foreground">{t('checkout.upgradeAmount')}</p>
          ) : null}
        </fieldset>
      )}

      <p className="text-xs text-muted-foreground">{t('checkout.pricesIncludeVat')}</p>

      {error !== null ? (
        <Alert variant="destructive" className="space-y-2">
          <p>{error}</p>
          {pendingPaymentId !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStage({ kind: 'paying', paymentId: pendingPaymentId })}
            >
              {t('payment.resume')}
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <Button
        size="lg"
        className="w-full sm:w-auto"
        onClick={() => void pay()}
        disabled={checkout.isPending}
      >
        {checkout.isPending ? t('checkout.submitting') : t('checkout.pay')}
      </Button>
    </section>
  );
}
