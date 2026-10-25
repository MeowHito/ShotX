'use client';

import type { SubscriptionView } from '@shotx/shared';
import { Alert, buttonVariants } from '@shotx/ui';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { BILLING_HREF } from '@/components/drive/paths';
import { useSubscription } from '@/lib/billing/queries';

/** The banner of a subscription state, or null when there is nothing to say (active). */
export function SubscriptionStateBanner({
  subscription,
  showAction = true,
}: {
  subscription: SubscriptionView | null;
  showAction?: boolean;
}) {
  const t = useTranslations('billing.banners');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  let text: string;
  let variant: 'default' | 'warning' | 'destructive' = 'warning';
  let action = t('renew');
  if (subscription === null) {
    text = t('none');
    action = t('choosePlan');
  } else {
    switch (subscription.status) {
      case 'trial':
        text = t('trial', { date: date(subscription.periodEnd) });
        variant = 'default';
        action = t('choosePlan');
        break;
      case 'grace':
        // Grace ends at expiresAt: renew before then or the shares stop working.
        text = t('grace', { date: date(subscription.expiresAt) });
        break;
      case 'expired':
        text = t('expired', { date: date(subscription.purgeAt) });
        variant = 'destructive';
        break;
      case 'purged':
        text = t('purged');
        variant = 'destructive';
        action = t('choosePlan');
        break;
      default:
        return null;
    }
  }
  return (
    <Alert variant={variant} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="flex-1">{text}</span>
      {showAction ? (
        <Link href={BILLING_HREF} className={buttonVariants({ size: 'sm' })}>
          {action}
        </Link>
      ) : null}
    </Alert>
  );
}

/** Trial, grace ("renew by ...") and expired banners on every studio page. */
export function SubscriptionBanner() {
  const subscription = useSubscription();
  if (subscription.data === undefined) return null;
  return <SubscriptionStateBanner subscription={subscription.data.subscription} />;
}
