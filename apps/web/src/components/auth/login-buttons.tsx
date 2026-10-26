import type { OidcProvider } from '@shotx/shared';
import { Alert, Button, buttonVariants, cn, Input, Label } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { AUTH_PATHS } from '@/lib/auth/handlers';

export interface LoginButtonsProps {
  options: {
    /** Identity providers to offer, in display order (only those configured). */
    oidc: readonly OidcProvider[];
    /** The development sign-in form (AUTH_PROVIDER=local). */
    devLogin: boolean;
  };
  /** Same-origin path to return to after signing in (already safeNextPath'ed). */
  next: string;
}

function loginHref(provider: OidcProvider, next: string): string {
  return `${AUTH_PATHS.login}?${new URLSearchParams({ provider, next }).toString()}`;
}

const PROVIDER_STYLES: Record<OidcProvider, string> = {
  line: cn(buttonVariants({ size: 'lg' }), 'bg-[#06C755] text-white hover:bg-[#06C755]/90'),
  google: buttonVariants({ size: 'lg', variant: 'outline' }),
};

/**
 * The sign-in choices: LINE and Google as plain links (route handlers that redirect to the
 * provider, so no client-side navigation or prefetch), and in local development a form that
 * POSTs an email and name to the development sign-in (never in a URL).
 */
export function LoginButtons({ options, next }: LoginButtonsProps) {
  const t = useTranslations('login');
  if (options.oidc.length === 0 && !options.devLogin) {
    return <Alert variant="destructive">{t('noProviders')}</Alert>;
  }
  return (
    <div className="grid gap-6">
      {options.oidc.length > 0 ? (
        <div className="grid gap-3">
          {options.oidc.map((provider) => (
            <a key={provider} href={loginHref(provider, next)} className={PROVIDER_STYLES[provider]}>
              {t(provider)}
            </a>
          ))}
        </div>
      ) : null}
      {options.devLogin ? (
        <section aria-labelledby="dev-login-title" className="grid gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <h2 id="dev-login-title" className="font-semibold">
              {t('dev.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('dev.subtitle')}</p>
          </div>
          <form method="post" action={AUTH_PATHS.devLogin} className="grid gap-4">
            <input type="hidden" name="next" value={next} />
            <div className="grid gap-2">
              <Label htmlFor="dev-login-email">{t('dev.email')}</Label>
              <Input
                id="dev-login-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                defaultValue="photographer@shotx.test"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dev-login-name">{t('dev.name')}</Label>
              <Input
                id="dev-login-name"
                name="name"
                required
                maxLength={200}
                defaultValue={t('dev.defaultName')}
              />
            </div>
            <Button type="submit" size="lg">
              {t('dev.submit')}
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
