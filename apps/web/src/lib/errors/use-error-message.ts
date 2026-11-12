'use client';

import type { BillingNotice, SubscriptionStatus } from '@shotx/shared';
import { useLocale, useTranslations } from 'next-intl';
import { intlLocale } from '../../i18n/config';
import { useCallback } from 'react';
import { describeError, messageForNotice } from './messages';

/** `(error) => Thai message`, for components. */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations('errors');
  const tStatus = useTranslations('usage.subscriptionStatus');
  const locale = intlLocale(useLocale());
  return useCallback(
    (error: unknown) => {
      const { key, values } = describeError(error, {
        subscriptionStatus: (status) => tStatus(status as SubscriptionStatus),
        locale,
      });
      // Keys are checked by ErrorMessageKey; values are checked by the i18n tests.
      return t(key, values as never);
    },
    [t, tStatus, locale],
  );
}

/** `(notice) => Thai message` for informational billing notices. */
export function useNoticeMessage(): (notice: BillingNotice) => string {
  const t = useTranslations('errors');
  const locale = intlLocale(useLocale());
  return useCallback(
    (notice: BillingNotice) => {
      const { key, values } = messageForNotice(notice, locale);
      return t(key, values as never);
    },
    [t, locale],
  );
}
