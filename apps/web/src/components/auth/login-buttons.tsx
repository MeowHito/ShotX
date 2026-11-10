import type { OidcProvider } from '@shotx/shared';
import { Alert, Button, buttonVariants, cn, Input, Label } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { PasswordSignInForm } from './password-sign-in-form';

export interface LoginButtonsProps {
  options: {
    /** Photographer email + password (ADR 0010; API-issued tokens). */
    password: boolean;
    /** Identity providers to offer, in display order (only those configured). */
    oidc: readonly OidcProvider[];
    /** The development sign-in form (AUTH_PROVIDER=local). */
    devLogin: boolean;
  };
  /** Same-origin path to return to after signing in (already safeNextPath'ed). */
  next: string;
  /** Tests route the password sign-in to the handler. */
  fetch?: typeof fetch;
}

function loginHref(provider: OidcProvider, next: string): string {
  return `${AUTH_PATHS.login}?${new URLSearchParams({ provider, next }).toString()}`;
}

const PROVIDER_STYLES: Record<OidcProvider, string> = {
  line: cn(buttonVariants({ size: 'lg' }), 'bg-[#06C755] text-white hover:bg-[#06C755]/90'),
  google: buttonVariants({ size: 'lg', variant: 'outline' }),
};

/** LINE and Google under the email + password form: secondary, for photographers who used them. */
const SECONDARY_PROVIDER_STYLES: Record<OidcProvider, string> = {
  line: cn(buttonVariants({ variant: 'outline' }), 'h-11'),
  google: cn(buttonVariants({ variant: 'outline' }), 'h-11'),
};

/**
 * The studio's sign-in choices (ADR 0010):
 * - email + password first (the accounts admins create), with "ask the admin for an account"
 *   instead of a sign-up link;
 * - LINE and Google below it, smaller, for photographers who already signed in with them. They
 *   are plain links (route handlers that redirect to the provider, so no client-side navigation
 *   or prefetch). Without the password sign-in (Cognito) they are the main choice;
 * - in local development a form that POSTs an email and name to the development sign-in (never
 *   in a URL).
 * Viewers of a share with require_login never come here: the share page links to LINE and Google
 * itself.
 */
export function LoginButtons({ options, next, fetch }: LoginButtonsProps) {
  const t = useTranslations('login');
  if (!options.password && options.oidc.length === 0 && !options.devLogin) {
    return <Alert variant="destructive">{t('noProviders')}</Alert>;
  }
  const styles = options.password ? SECONDARY_PROVIDER_STYLES : PROVIDER_STYLES;
  return (
    <div className="grid gap-6">
      {options.password ? <PasswordSignInForm next={next} fetch={fetch} /> : null}
      {options.password && options.oidc.length > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          {t('or')}
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      {options.oidc.length > 0 ? (
        <div className="grid gap-3">
          {options.password ? (
            <p className="text-sm text-muted-foreground">{t('legacy')}</p>
          ) : null}
          {options.oidc.map((provider) => (
            <a key={provider} href={loginHref(provider, next)} className={styles[provider]}>
              {t(provider)}
            </a>
          ))}
        </div>
      ) : null}
      {options.devLogin ? (
        <section aria-labelledby="dev-login-title" className="grid gap-4 rounded-xl border bg-sidebar p-4">
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
