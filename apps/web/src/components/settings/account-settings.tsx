'use client';

import { Alert } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

/**
 * `/studio/settings`: who is signed in, and the password change (password.title) for email + password
 * accounts (ADR 0010). Name and email are set by the admin. LINE/Google accounts have no
 * password to change.
 */
export function AccountSettings({
  user,
  passwordAccount,
  minLength,
  fetch,
}: {
  user: { name: string | null; email: string | null } | null;
  /** The session is an email + password account (`password:` subject); unknown counts as yes. */
  passwordAccount: boolean;
  minLength: number;
  fetch?: typeof globalThis.fetch;
}) {
  const t = useTranslations('settings');
  const tp = useTranslations('password');
  const passwordHeading = useId();
  const [changed, setChanged] = useState(false);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
        {t('title')}
      </h1>
      <section className="space-y-3 rounded-xl border p-4 sm:p-6">
        <h2 className="text-lg">{t('account')}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('name')}</dt>
          <dd className="min-w-0 truncate">{user?.name ?? '-'}</dd>
          <dt className="text-muted-foreground">{t('email')}</dt>
          <dd className="min-w-0 truncate">{user?.email ?? '-'}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">{t('contactAdmin')}</p>
      </section>
      <section aria-labelledby={passwordHeading} className="space-y-4 rounded-xl border p-4 sm:p-6">
        <div className="space-y-1">
          <h2 id={passwordHeading} className="text-lg">
            {tp('title')}
          </h2>
          {passwordAccount ? <p className="text-sm text-muted-foreground">{tp('body')}</p> : null}
        </div>
        {passwordAccount ? (
          <>
            {changed ? (
              <Alert role="status" aria-live="polite">
                {tp('done')}
              </Alert>
            ) : null}
            <ChangePasswordForm
              mode="voluntary"
              email={user?.email ?? null}
              minLength={minLength}
              fetch={fetch}
              onChanged={() => setChanged(true)}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{tp('noPassword')}</p>
        )}
      </section>
    </div>
  );
}
