'use client';

import type { ShareUnavailableReason } from '@shotx/shared';
import { Alert, Button, buttonVariants, cn, Input, Label } from '@shotx/ui';
import { LockIcon, LogInIcon, TimerOffIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import {
  ALL_VIEWER_LOGINS,
  canViewerSignIn,
  type ViewerLoginOptions,
} from '@/lib/auth/viewer-login';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useUnlockShare } from '@/lib/share/queries';

/**
 * The "link expired" page for every SHARE_EXPIRED reason (revoked, expired, unavailable). ADR 0011
 * decision 2: it no longer links to "delete my face" (the page stays at its URL, unlinked).
 */
export function ShareUnavailable({ reason }: { reason: ShareUnavailableReason | null }) {
  const tu = useTranslations('share.unavailable');
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <TimerOffIcon className="size-12 text-muted-foreground" aria-hidden />
      {/* ADR 0016: an unpublished event comes back with the same link; no "ask for a new one". */}
      <h1 className="text-2xl font-bold">
        {reason === 'paused' ? tu('pausedTitle') : tu('title')}
      </h1>
      {reason !== null ? <p className="text-muted-foreground">{tu(`reasons.${reason}`)}</p> : null}
      {reason === 'paused' ? null : <p className="text-sm text-muted-foreground">{tu('body')}</p>}
    </div>
  );
}

/** Sign-in that returns to the share page (`path`: meta.path, the slug URL). */
function loginHref(provider: 'line' | 'google', path: string): string {
  return `${AUTH_PATHS.login}?${new URLSearchParams({ provider, next: path }).toString()}`;
}

const PROVIDER_STYLES = {
  line: cn(buttonVariants({ size: 'lg' }), 'bg-[#06C755] text-white hover:bg-[#06C755]/90'),
  google: buttonVariants({ size: 'lg', variant: 'outline' }),
} as const;

/**
 * require_login: sign in with LINE or Google (only those configured), then come back to this
 * page, which creates the viewer session (POST /bff/me/viewer-session) and reloads. With no
 * viewer sign-in at all (LINE/Google off in production) it says so and to contact the
 * photographer, instead of showing buttons that can't work.
 */
export function LoginRequired({
  path,
  options = ALL_VIEWER_LOGINS,
}: {
  /** meta.path: where the sign-in returns to. */
  path: string;
  options?: ViewerLoginOptions;
}) {
  const tl = useTranslations('share.login');
  if (!canViewerSignIn(options)) {
    return (
      <div className="mx-auto flex max-w-sm flex-col gap-4 py-12">
        <LogInIcon className="size-10 text-muted-foreground" aria-hidden />
        <h1 className="text-2xl font-bold">{tl('unavailableTitle')}</h1>
        <p className="text-muted-foreground">{tl('unavailableBody')}</p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-12">
      <LogInIcon className="size-10 text-primary" aria-hidden />
      <h1 className="text-2xl font-bold">{tl('title')}</h1>
      <p className="text-muted-foreground">{tl('body')}</p>
      {/* Plain links: route handlers that redirect to LINE or Google. */}
      {options.oidc.map((provider) => (
        <a key={provider} href={loginHref(provider, path)} className={PROVIDER_STYLES[provider]}>
          {tl(provider)}
        </a>
      ))}
      {options.devLogin ? (
        <a
          href={`${AUTH_PATHS.loginPage}?${new URLSearchParams({ next: path }).toString()}`}
          className={buttonVariants({ size: 'lg', variant: 'outline' })}
        >
          {tl('devLogin')}
        </a>
      ) : null}
    </div>
  );
}

export function PasswordForm({ token }: { token: string }) {
  const tp = useTranslations('share.password');
  const describe = useErrorMessage();
  const inputId = useId();
  const unlock = useUnlockShare(token);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password === '') return;
    setError(null);
    try {
      await unlock.mutateAsync(password);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mx-auto flex max-w-sm flex-col gap-4 py-12"
      noValidate
    >
      <LockIcon className="size-10 text-primary" aria-hidden />
      <h1 className="text-2xl font-bold">{tp('title')}</h1>
      <p className="text-muted-foreground">{tp('body')}</p>
      <div className="grid gap-2">
        <Label htmlFor={inputId}>{tp('label')}</Label>
        <Input
          id={inputId}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          enterKeyHint="go"
          aria-invalid={error !== null}
        />
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <Button type="submit" size="lg" disabled={unlock.isPending || password === ''}>
        {tp('submit')}
      </Button>
    </form>
  );
}
