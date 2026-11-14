'use client';

import { Alert, Button, Input, Label } from '@shotx/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { requestPasswordReset } from '@/lib/auth/password-client';
import { useErrorMessage } from '@/lib/errors/use-error-message';

/**
 * "forgot password" (ADR 0025): the photographer types their email and the API emails a one-time
 * link. The answer is the same whether or not the email has an account, so the page always says
 * "check your email" (worded "if this email has an account").
 */
export function ForgotPasswordForm({
  fetch: fetchImpl,
}: {
  /** Tests route the request to the handler. */
  fetch?: typeof fetch;
}) {
  const t = useTranslations('passwordReset');
  const describe = useErrorMessage();
  const emailId = useId();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = email.trim();
    if (value === '') {
      setError(t('emailMissing'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await requestPasswordReset(value, fetchImpl);
      setSentTo(value);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo !== null) {
    return (
      <div className="grid gap-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl">{t('sentTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('sentBody', { email: sentTo })}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-12"
          onClick={() => setSentTo(null)}
        >
          {t('sendAgain')}
        </Button>
        <Link
          href={AUTH_PATHS.loginPage}
          className="text-center text-sm underline underline-offset-4"
        >
          {t('backToLogin')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <div className="space-y-1.5">
        <h1 className="text-2xl">{t('requestTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('requestBody')}</p>
      </div>
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
      {error !== null ? (
        <Alert id={errorId} variant="destructive">
          {error}
        </Alert>
      ) : null}
      <Button type="submit" size="lg" className="h-12" disabled={busy}>
        {busy ? t('sending') : t('send')}
      </Button>
      <Link
        href={AUTH_PATHS.loginPage}
        className="text-center text-sm underline underline-offset-4"
      >
        {t('backToLogin')}
      </Link>
    </form>
  );
}
