import { parseAuthSubject } from '@shotx/shared';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AccountSettings } from '@/components/settings/account-settings';
import { viewerState } from '@/lib/server/auth';
import { clientPasswordPolicy } from '@/lib/server/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings');
  return { title: t('title') };
}

/**
 * Account settings. The password change is offered to email + password accounts (`password:`
 * subjects, ADR 0010); when the session cookie has expired (only the refresh token is left) the
 * subject is unknown and the form shows, since the API answers for any account anyway.
 */
export default async function SettingsPage() {
  const viewer = await viewerState();
  const subject = viewer.user === null ? null : parseAuthSubject(viewer.user.sub);
  const passwordAccount = viewer.user === null || subject?.provider === 'password';
  return (
    <AccountSettings
      user={viewer.user === null ? null : { name: viewer.user.name, email: viewer.user.email }}
      passwordAccount={passwordAccount}
      minLength={clientPasswordPolicy().minLength}
    />
  );
}
