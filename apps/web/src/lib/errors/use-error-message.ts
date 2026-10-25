'use client';

import type { SubscriptionStatus } from '@shotx/shared';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { describeError } from './messages';

/** `(error) => Thai message`, for components. */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations('errors');
  const tStatus = useTranslations('usage.subscriptionStatus');
  return useCallback(
    (error: unknown) => {
      const { key, values } = describeError(error, {
        subscriptionStatus: (status) => tStatus(status as SubscriptionStatus),
      });
      // Keys are checked by ErrorMessageKey; values are checked by the i18n tests.
      return t(key, values as never);
    },
    [t, tStatus],
  );
}
