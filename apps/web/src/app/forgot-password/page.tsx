import { Alert } from '@shotx/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCardShell } from '@/components/auth/auth-card-shell';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { loginOptions } from '@/lib/server/auth';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('passwordReset');
  return { title: t('requestTitle') };
}

/** `/forgot-password` (ADR 0025): asks for an emailed reset link. */
export default async function ForgotPasswordPage() {
  const t = await getTranslations('passwordReset');
  const options = await loginOptions();
  return (
    <AuthCardShell>
      {options?.passwordReset === true ? (
        <ForgotPasswordForm />
      ) : (
        <div className="grid gap-4">
          <h1 className="text-2xl">{t('requestTitle')}</h1>
          <Alert>{t('unavailable')}</Alert>
          <Link
            href={AUTH_PATHS.loginPage}
            className="text-center text-sm underline underline-offset-4"
          >
            {t('backToLogin')}
          </Link>
        </div>
      )}
    </AuthCardShell>
  );
}
