'use client';

import type { ShareUnavailableReason } from '@shotx/shared';
import { Alert, Button, buttonVariants, cn, Input, Label } from '@shotx/ui';
import { LockIcon, LogInIcon, TimerOffIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useUnlockShare } from '@/lib/share/queries';

/** The "delete my face" page of a share (works on expired and revoked shares too). */
export function faceDeletionHref(token: string): string {
  return `/s/${token}/delete-my-face`;
}

/**
 * The "link expired" page for every SHARE_EXPIRED reason (revoked, expired, unavailable). It
 * still offers "delete my face": a PDPA right that outlives the share.
 */
export function ShareUnavailable({
  token,
  reason,
}: {
  token: string;
  reason: ShareUnavailableReason | null;
}) {
  const tu = useTranslations('share.unavailable');
  const ts = useTranslations('share');
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <TimerOffIcon className="size-12 text-muted-foreground" aria-hidden />
      <h1 className="text-2xl font-bold">{tu('title')}</h1>
      {reason !== null ? <p className="text-muted-foreground">{tu(`reasons.${reason}`)}</p> : null}
      <p className="text-sm text-muted-foreground">{tu('body')}</p>
      <div className="mt-6 space-y-2 border-t pt-6 text-sm">
        <p className="text-muted-foreground">{tu('deleteHint')}</p>
        <Link
          href={faceDeletionHref(token)}
          className={buttonVariants({ variant: 'outline', size: 'lg' })}
        >
          {ts('deleteMyFace')}
        </Link>
      </div>
    </div>
  );
}

function loginHref(provider: 'line' | 'google', token: string): string {
  return `${AUTH_PATHS.login}?${new URLSearchParams({ provider, next: `/s/${token}` }).toString()}`;
}

/**
 * require_login: sign in with LINE or Google, then come back to this page, which
 * creates the viewer session (POST /bff/me/viewer-session) and reloads.
 */
export function LoginRequired({ token }: { token: string }) {
  const tl = useTranslations('share.login');
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-12">
      <LogInIcon className="size-10 text-primary" aria-hidden />
      <h1 className="text-2xl font-bold">{tl('title')}</h1>
      <p className="text-muted-foreground">{tl('body')}</p>
      {/* Plain links: route handlers that redirect to LINE or Google. */}
      <a
        href={loginHref('line', token)}
        className={cn(
          buttonVariants({ size: 'lg' }),
          'bg-[#06C755] text-white hover:bg-[#06C755]/90',
        )}
      >
        {tl('line')}
      </a>
      <a
        href={loginHref('google', token)}
        className={buttonVariants({ size: 'lg', variant: 'outline' })}
      >
        {tl('google')}
      </a>
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
