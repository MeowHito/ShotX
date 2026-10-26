import { Alert, Button, Input, Label } from '@shotx/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LOCAL_AUTH_AUTHORIZE_PATH } from '@/lib/auth/local';
import { webConfig } from '@/lib/server/config';

const param = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

/** Stand-in for the Cognito Hosted UI with AUTH_PROVIDER=local (development only). */
export default async function LocalLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (webConfig().auth.provider !== 'local') notFound();
  const t = await getTranslations('localLogin');
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>
      <Alert>{t('notice')}</Alert>
      <form method="post" action={LOCAL_AUTH_AUTHORIZE_PATH} className="grid gap-4">
        <input type="hidden" name="state" value={param(params.state)} />
        <input type="hidden" name="code_challenge" value={param(params.code_challenge)} />
        <input type="hidden" name="redirect_uri" value={param(params.redirect_uri)} />
        <div className="grid gap-2">
          <Label htmlFor="local-email">{t('email')}</Label>
          <Input
            id="local-email"
            name="email"
            type="email"
            required
            defaultValue="photographer@shotx.test"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="local-name">{t('name')}</Label>
          <Input id="local-name" name="name" required defaultValue={t('defaultName')} />
        </div>
        <Button type="submit" size="lg">
          {t('submit')}
        </Button>
      </form>
    </main>
  );
}
