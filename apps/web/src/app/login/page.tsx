import { Alert, buttonVariants, cn } from '@shotx/ui';
import { getTranslations } from 'next-intl/server';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { safeNextPath } from '@/lib/auth/session';

const ERRORS = ['cancelled', 'failed', 'expired'] as const;

function loginHref(provider: 'google' | 'line' | 'email', next: string): string {
  return `${AUTH_PATHS.login}?${new URLSearchParams({ provider, next }).toString()}`;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('login');
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === 'string' ? params.next : null);
  const error = ERRORS.find((e) => e === params.error);

  // Plain links, not <Link>: these are route handlers that redirect to the Cognito Hosted UI.
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>
      {error !== undefined ? <Alert variant="destructive">{t(`errors.${error}`)}</Alert> : null}
      <div className="grid gap-3">
        <a
          href={loginHref('line', next)}
          className={cn(
            buttonVariants({ size: 'lg' }),
            'bg-[#06C755] text-white hover:bg-[#06C755]/90',
          )}
        >
          {t('line')}
        </a>
        <a
          href={loginHref('google', next)}
          className={buttonVariants({ size: 'lg', variant: 'outline' })}
        >
          {t('google')}
        </a>
        <a
          href={loginHref('email', next)}
          className={buttonVariants({ size: 'lg', variant: 'ghost' })}
        >
          {t('email')}
        </a>
      </div>
    </main>
  );
}
