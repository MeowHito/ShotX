import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCardShell } from '@/components/auth/auth-card-shell';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { clientPasswordPolicy } from '@/lib/server/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('passwordReset');
  return { title: t('resetTitle'), referrer: 'no-referrer', robots: { index: false } };
}

/**
 * `/reset-password#token=…` (ADR 0025, PHOTOGRAPHER_PASSWORD_RESET_PATH): the emailed link. The
 * token is in the fragment, so it never reaches a server log; the form reads it in the browser.
 */
export default function ResetPasswordPage() {
  return (
    <AuthCardShell>
      <ResetPasswordForm minLength={clientPasswordPolicy().minLength} />
    </AuthCardShell>
  );
}
