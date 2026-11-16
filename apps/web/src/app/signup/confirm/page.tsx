import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCardShell } from '@/components/auth/auth-card-shell';
import { SignupConfirmForm } from '@/components/auth/signup-confirm-form';
import { clientPasswordPolicy } from '@/lib/server/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('signup');
  return { title: t('title'), referrer: 'no-referrer', robots: { index: false } };
}

/**
 * `/signup/confirm#token=…` (ADR 0026, SIGNUP_CONFIRM_PATH): the Free sign-up email's link. The
 * token is in the fragment, so it never reaches a server log; the form reads it in the browser.
 */
export default function SignupConfirmPage() {
  return (
    <AuthCardShell>
      <SignupConfirmForm minLength={clientPasswordPolicy().minLength} />
    </AuthCardShell>
  );
}
