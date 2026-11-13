'use client';

import type { PublicPlan, SubscriptionResponse } from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@shotx/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  PublicApiContext,
  useCancelAutoRenew,
  usePlans,
  useSubscription,
} from '@/lib/billing/queries';
import { useErrorMessage, useNoticeMessage } from '@/lib/errors/use-error-message';
import { useFormatBytes, useFormatSatang } from '@/lib/i18n/use-format';
import { CheckoutFlow, PlanPicker } from './checkout-flow';
import { SubscriptionStateBanner } from './subscription-banner';

export interface BillingViewProps {
  /** WEB_BILLING_POLL_INTERVAL_MS. */
  pollIntervalMs: number;
  /** `?plan=` from the pricing page: open its checkout directly. */
  initialPlanCode?: string;
  /** Tests: the fake public API and navigation. */
  testing?: { publicApi?: ApiClient; redirect?: (url: string) => void };
}

/** `/studio/billing`: the current subscription, cancel auto-renew, and changing plan. */
export function BillingView({ testing, ...props }: BillingViewProps) {
  const view = <Billing {...props} redirect={testing?.redirect} />;
  return testing?.publicApi ? (
    <PublicApiContext.Provider value={testing.publicApi}>{view}</PublicApiContext.Provider>
  ) : (
    view
  );
}

function defaultRedirect(url: string) {
  // The gateway's hosted card page: card numbers are never typed into this app.
  window.location.assign(url);
}

function Billing({
  pollIntervalMs,
  initialPlanCode,
  redirect = defaultRedirect,
}: Omit<BillingViewProps, 'testing'> & { redirect?: (url: string) => void }) {
  const t = useTranslations('billing');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const subscription = useSubscription();
  const plans = usePlans();
  const [chosen, setChosen] = useState<string | null>(initialPlanCode ?? null);

  const loading = subscription.isPending || plans.isPending;
  const plan: PublicPlan | undefined =
    chosen === null ? undefined : plans.data?.plans.find((p) => p.code === chosen);

  return (
    <div className="w-full space-y-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      {subscription.isError ? (
        <Alert variant="destructive">
          {t('current.loadError')}: {describe(subscription.error)}
        </Alert>
      ) : null}
      {subscription.data !== undefined ? <CurrentSubscription data={subscription.data} /> : null}
      {plans.isError ? (
        <Alert variant="destructive">
          {t('plans.loadError')}: {describe(plans.error)}
        </Alert>
      ) : null}
      {loading ? (
        <p role="status" className="text-muted-foreground">
          {tc('loading')}
        </p>
      ) : null}
      {plans.data !== undefined && subscription.data !== undefined ? (
        plan !== undefined ? (
          <CheckoutFlow
            key={plan.code}
            plan={plan}
            plans={plans.data}
            subscription={subscription.data.subscription}
            pollIntervalMs={pollIntervalMs}
            redirect={redirect}
            onBack={() => setChosen(null)}
          />
        ) : (
          <PlanPicker
            plans={plans.data}
            subscription={subscription.data.subscription}
            onSelect={(p) => setChosen(p.code)}
          />
        )
      ) : null}
    </div>
  );
}

function CurrentSubscription({ data }: { data: SubscriptionResponse }) {
  const formatBytes = useFormatBytes();
  const formatSatang = useFormatSatang();
  const tcur = useTranslations('billing.current');
  const tStatus = useTranslations('usage.subscriptionStatus');
  const describe = useErrorMessage();
  const noticeText = useNoticeMessage();
  const format = useFormatter();
  const cancel = useCancelAutoRenew();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const sub = data.subscription;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  async function confirmCancel() {
    setMessage(null);
    try {
      await cancel.mutateAsync();
      setOpen(false);
      setMessage({ kind: 'info', text: tcur('canceledDone') });
    } catch (err) {
      setOpen(false);
      setMessage({ kind: 'error', text: describe(err) });
    }
  }

  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label={tcur('heading')}>
      <h2 className="text-lg font-semibold">{tcur('heading')}</h2>
      <SubscriptionStateBanner subscription={sub} showAction={false} />
      {sub === null ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{tcur('plan')}</dt>
          <dd className="font-medium">{sub.plan.name}</dd>
          <dt className="text-muted-foreground">{tcur('status')}</dt>
          <dd>{tStatus(sub.status)}</dd>
          <dt className="text-muted-foreground">{tcur('quota')}</dt>
          <dd>{formatBytes(sub.plan.quotaBytes)}</dd>
          <dt className="text-muted-foreground">{tcur('periodEnd')}</dt>
          <dd>{date(sub.periodEnd)}</dd>
          <dt className="text-muted-foreground">{tcur('renewal')}</dt>
          <dd>
            {sub.billing === 'auto_renew' && sub.autoRenewMonths !== null
              ? tcur('autoRenewEvery', { months: sub.autoRenewMonths })
              : sub.cancelAtPeriodEnd
                ? tcur('canceled', { date: date(sub.periodEnd) })
                : tcur(`modes.${sub.billing}`)}
          </dd>
        </dl>
      )}
      {sub?.nextRenewal ? (
        <p className="text-sm">
          {tcur('nextRenewal', {
            date: date(sub.nextRenewal.at),
            plan: sub.nextRenewal.plan.name,
            price: formatSatang(sub.nextRenewal.amount.totalSatang),
          })}
        </p>
      ) : null}
      {sub?.pendingChange ? (
        <Alert variant="warning">
          {tcur('pendingDowngrade', {
            plan: sub.pendingChange.plan.name,
            quota: formatBytes(sub.pendingChange.plan.quotaBytes),
            date: date(sub.pendingChange.effectiveAt),
          })}
        </Alert>
      ) : null}
      {data.notices.map((n) => (
        <Alert key={n.code} variant="warning">
          {noticeText(n)}
        </Alert>
      ))}
      {message !== null ? (
        <Alert variant={message.kind === 'error' ? 'destructive' : 'default'} role="status">
          {message.text}
        </Alert>
      ) : null}
      {sub?.billing === 'auto_renew' ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">{tcur('cancelAutoRenew')}</Button>
          </DialogTrigger>
          <DialogContent closeLabel={tcur('cancelKeep')}>
            <DialogHeader>
              <DialogTitle>{tcur('cancelTitle')}</DialogTitle>
              <DialogDescription>
                {tcur('cancelBody', { date: date(sub.periodEnd) })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">{tcur('cancelKeep')}</Button>
              </DialogClose>
              <Button
                variant="destructive"
                onClick={() => void confirmCancel()}
                disabled={cancel.isPending}
              >
                {tcur('cancelConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
