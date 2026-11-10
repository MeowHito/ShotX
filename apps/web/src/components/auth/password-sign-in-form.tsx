'use client';

import { Alert, Button, Input, Label } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { requestPasswordSignIn } from '@/lib/auth/password-client';
import { navigateTo } from '@/lib/browser/navigate';
import { useErrorMessage } from '@/lib/errors/use-error-message';

/**
 * Photographer sign-in with the email and password an admin handed out (ADR 0010). The request
 * goes to web's own route handler, which stores the session in httpOnly cookies; then a full
 * navigation to `next`, or to the change-password page when the password is temporary. There is
 * no sign-up: new photographers are told to ask the admin for an account.
 */
export function PasswordSignInForm({
  next,
  fetch: fetchImpl,
}: {
  /** Same-origin path to return to (already safeNextPath'ed). */
  next: string;
  /** Tests route the request to the handler. */
  fetch?: typeof fetch;
}) {
  const t = useTranslations('login');
  const describe = useErrorMessage();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === '' || password === '') {
      setError(t('errors.missing'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await requestPasswordSignIn(
        { email: email.trim(), password, next },
        fetchImpl,
      );
      // Stay busy: the page is about to change.
      navigateTo(result.redirectTo);
    } catch (err) {
      setError(describe(err));
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <div className="grid gap-2">
        <Label htmlFor={emailId}>{t('email')}</Label>
        <Input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-describedby={error !== null ? errorId : undefined}
          className="h-12 md:h-10"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={passwordId}>{t('password')}</Label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={error !== null ? errorId : undefined}
          className="h-12 md:h-10"
        />
      </div>
      {error !== null ? (
        <Alert id={errorId} variant="destructive">
          {error}
        </Alert>
      ) : null}
      <Button type="submit" size="lg" className="h-12" disabled={busy}>
        {busy ? t('submitting') : t('submit')}
      </Button>
      <p className="text-sm text-muted-foreground">{t('noAccount')}</p>
    </form>
  );
}
