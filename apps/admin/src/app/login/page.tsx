import { getTranslations } from 'next-intl/server';
import { SignInFlow } from '@/components/auth/sign-in-flow';
import { safeNextPath } from '@/lib/auth/session';
import { adminMfaMode } from '@/lib/server/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('login');
  const tc = await getTranslations('common');
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === 'string' ? params.next : null);
  const notice = params.error === 'session' ? 'session' : null;
  const mfaMode = await adminMfaMode();

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-12">
      <p className="mb-6 flex items-center gap-2 text-xl font-bold tracking-[-0.015em]">
        {tc('appName')}
        <span className="rounded-md bg-band px-1.5 py-0.5 text-xs font-semibold text-band-foreground">
          {tc('adminBadge')}
        </span>
      </p>
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-background p-6 shadow-float sm:p-8">
        <div className="space-y-1.5">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1 className="text-2xl">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {mfaMode === 'totp' ? t('subtitleTotp') : t('subtitle')}
          </p>
        </div>
        <SignInFlow next={next} initialNotice={notice} />
      </div>
    </main>
  );
}
