import { Alert } from '@shotx/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LoginButtons } from '@/components/auth/login-buttons';
import { LanguageSwitcher } from '@/components/site/language-switcher';
import { LOGIN_ERROR_CODES, LOGIN_ERROR_REASONS } from '@/lib/auth/handlers';
import { safeNextPath } from '@/lib/auth/session';
import { messageForCode } from '@/lib/errors/messages';
import { loginOptions } from '@/lib/server/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('login');
  const tc = await getTranslations('common');
  const te = await getTranslations('errors');
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === 'string' ? params.next : null);
  const reason = LOGIN_ERROR_REASONS.find((e) => e === params.error);
  const code = LOGIN_ERROR_CODES.find((e) => e === params.error);
  // API codes go through the one error map; outcomes decided in web have their own copy.
  const codeMessage = code !== undefined ? messageForCode(code, undefined) : null;
  const error =
    reason !== undefined
      ? t(`errors.${reason}`)
      : codeMessage !== null
        ? te(codeMessage.key, codeMessage.values as never)
        : null;
  const options = await loginOptions();

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-16">
      <div className="absolute top-3 right-3">
        <LanguageSwitcher />
      </div>
      <Link
        href="/"
        className="mb-6 rounded-md px-1 text-xl font-bold tracking-[-0.015em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {tc('appName')}
      </Link>
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-background p-6 shadow-float sm:p-8">
        <div className="space-y-1.5">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1 className="text-2xl">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {options?.password === true ? t('passwordSubtitle') : t('subtitle')}
          </p>
        </div>
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
        {options === null ? (
          <Alert variant="destructive">{t('unavailable')}</Alert>
        ) : (
          <LoginButtons options={options} next={next} />
        )}
      </div>
    </main>
  );
}
