'use client';

import { Alert, Button } from '@shotx/ui';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * Shows a just-set temporary password once, with a copy button. The password exists only in the
 * props of this panel inside an open dialog: closing the dialog unmounts it, and nothing keeps a
 * copy (no storage, URL, query cache or log). The clipboard is the admin's own action.
 */
export function OneTimePassword({
  email,
  password,
  heading,
  onDone,
}: {
  email: string;
  password: string;
  /** What just happened (created / reset). */
  heading: string;
  onDone: () => void;
}) {
  const t = useTranslations('oneTimePassword');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-primary" role="status">
        {heading}
      </p>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('title', { email })}</p>
        <div className="flex items-center gap-2 rounded-xl border bg-sidebar p-3">
          <code
            className="min-w-0 flex-1 font-mono text-base break-all select-all"
            aria-label={t('label')}
            data-testid="one-time-password"
          >
            {password}
          </code>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyPassword()}>
            {copy === 'copied' ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copy === 'copied' ? t('copied') : t('copy')}
          </Button>
        </div>
        {copy === 'failed' ? <p className="text-sm text-destructive">{t('copyFailed')}</p> : null}
      </div>
      <Alert variant="warning">
        <p>{t('note')}</p>
        <p className="mt-1">{t('firstSignIn')}</p>
      </Alert>
      <Button type="button" className="w-full" onClick={onDone}>
        {t('done')}
      </Button>
    </div>
  );
}
