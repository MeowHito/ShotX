'use client';

import { useTranslations } from 'next-intl';
import { LogoutButton } from '@/components/studio/logout-button';
import { afterPasswordChangePath } from '@/lib/auth/password-client';
import { navigateTo } from '@/lib/browser/navigate';
import { ChangePasswordForm } from './change-password-form';

/**
 * The forced change of a temporary password (ADR 0010): shown after a sign-in that answered
 * `change_password`, and whenever the session turns out to be restricted (GET /me
 * passwordChangeRequired, or any call answering PASSWORD_CHANGE_REQUIRED). Nothing else of the
 * studio loads here, since every other route would refuse the restricted session. On success the
 * cookies hold a normal session and the browser goes on to `next` with a full navigation.
 */
export function ChangePasswordScreen({
  email,
  minLength,
  next,
  fetch,
}: {
  email: string | null;
  minLength: number;
  /** Where to go afterwards (safeNextPath'ed; never this page). */
  next: string;
  fetch?: typeof globalThis.fetch;
}) {
  const t = useTranslations('password');
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <p className="eyebrow">{t('requiredEyebrow')}</p>
        <h1 className="text-2xl">{t('requiredTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('requiredBody')}</p>
      </div>
      <ChangePasswordForm
        mode="required"
        email={email}
        minLength={minLength}
        fetch={fetch}
        onChanged={() => navigateTo(afterPasswordChangePath(next))}
      />
      <div className="flex justify-center">
        <LogoutButton />
      </div>
    </div>
  );
}
