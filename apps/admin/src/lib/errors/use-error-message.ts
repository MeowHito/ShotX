'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { describeError } from './messages';

/** `(error) => Thai message`, for components. */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations('errors');
  return useCallback(
    (error: unknown) => {
      const { key, values } = describeError(error);
      // Keys are checked by ErrorMessageKey; values are checked by the i18n tests.
      return t(key, values as never);
    },
    [t],
  );
}
