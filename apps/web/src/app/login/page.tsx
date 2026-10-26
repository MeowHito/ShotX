import { Alert } from '@shotx/ui';
import { getTranslations } from 'next-intl/server';
import { LoginButtons } from '@/components/auth/login-buttons';
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
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      {options === null ? (
        <Alert variant="destructive">{t('unavailable')}</Alert>
      ) : (
        <LoginButtons options={options} next={next} />
      )}
    </main>
  );
}
