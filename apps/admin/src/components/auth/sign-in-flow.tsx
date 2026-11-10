'use client';

import { Alert, Button, Input, Label } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import {
  advance,
  fail,
  INITIAL_SIGN_IN_STATE,
  type SignInState,
  stepPath,
} from '@/lib/sign-in/machine';
import { postSignInStep } from '@/lib/sign-in/client';
import { TotpEnrolment } from './totp-enrolment';

/**
 * The admin sign-in: email + password → (set a new password) → (enrol TOTP) → TOTP code. Each
 * step is its own component, so what was typed in it (a password, a code) is dropped as soon as
 * the step changes; the TOTP enrolment URI is dropped with its step too. There is no way past the
 * code step except a valid code: the session cookies are set only by the API's answer to it.
 */
export function SignInFlow({
  next,
  initialNotice = null,
  fetchImpl,
  onSignedIn = (path) => window.location.assign(path),
}: {
  /** Where to go after signing in (already a safe same-origin path). */
  next: string;
  /** `session`: sent here because the session ended. */
  initialNotice?: 'session' | null;
  fetchImpl?: typeof fetch;
  onSignedIn?: (path: string) => void;
}) {
  const t = useTranslations('login');
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<SignInState>(INITIAL_SIGN_IN_STATE);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sessionNotice, setSessionNotice] = useState(initialNotice === 'session');

  async function submit(body: unknown) {
    const path = stepPath(state.step);
    if (path === null || pending) return;
    setPending(true);
    setError(null);
    setSessionNotice(false);
    try {
      const answer = await postSignInStep(path, body, fetchImpl);
      const nextState = advance(state, answer);
      setState(nextState);
      if (nextState.step === 'signed_in') onSignedIn(next);
    } catch (caught) {
      setError(errorMessage(caught));
      setState(fail(state, caught instanceof ApiError ? caught.code : null));
    } finally {
      setPending(false);
    }
  }

  function startOver() {
    setError(null);
    setState(INITIAL_SIGN_IN_STATE);
  }

  const notice =
    state.step === 'credentials' && state.notice !== null
      ? t(`notices.${state.notice}`)
      : sessionNotice
        ? t('notices.session')
        : null;

  return (
    <div className="space-y-5">
      {notice !== null ? <Alert variant="warning">{notice}</Alert> : null}
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      {state.step === 'credentials' ? (
        <CredentialsStep pending={pending} onSubmit={submit} />
      ) : state.step === 'change_password' ? (
        <ChangePasswordStep pending={pending} onSubmit={submit} />
      ) : state.step === 'enrol_totp' ? (
        <TotpEnrolment otpauthUri={state.otpauthUri}>
          <CodeStep pending={pending} onSubmit={submit} />
        </TotpEnrolment>
      ) : state.step === 'totp' ? (
        <StepHeader title={t('totp.title')} description={t('totp.description')}>
          <CodeStep pending={pending} onSubmit={submit} />
        </StepHeader>
      ) : (
        <p className="text-sm text-muted-foreground" role="status">
          {t('submitting')}
        </p>
      )}
      {state.step !== 'credentials' && state.step !== 'signed_in' ? (
        <Button variant="ghost" className="w-full" onClick={startOver} disabled={pending}>
          {t('startOver')}
        </Button>
      ) : null}
    </div>
  );
}

function StepHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function CredentialsStep({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (body: { email: string; password: string }) => Promise<void>;
}) {
  const t = useTranslations('login');
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    void onSubmit({ email: email.trim(), password });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor={`${id}-email`}>{t('email')}</Label>
        <Input
          id={`${id}-email`}
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-password`}>{t('password')}</Label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}

function ChangePasswordStep({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (body: { newPassword: string }) => Promise<void>;
}) {
  const t = useTranslations('login.changePassword');
  const tl = useTranslations('login');
  const id = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    void onSubmit({ newPassword: password });
  }

  return (
    <StepHeader title={t('title')} description={t('description')}>
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor={`${id}-new`}>{t('newPassword')}</Label>
          <Input
            id={`${id}-new`}
            type="password"
            autoComplete="new-password"
            required
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-confirm`}>{t('confirmPassword')}</Label>
          <Input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            required
            maxLength={256}
            value={confirm}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? `${id}-mismatch` : undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch ? (
            <p id={`${id}-mismatch`} className="text-sm text-destructive">
              {t('mismatch')}
            </p>
          ) : null}
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? tl('submitting') : t('submit')}
        </Button>
      </form>
    </StepHeader>
  );
}

const CODE_PATTERN = /^(\d{6}|\d{8})$/;

function CodeStep({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (body: { code: string }) => Promise<void>;
}) {
  const t = useTranslations('login.totp');
  const tl = useTranslations('login');
  const id = useId();
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const digits = code.replace(/\s/g, '');
    if (!CODE_PATTERN.test(digits)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    await onSubmit({ code: digits });
    // A wrong code is cleared so the next one is typed fresh.
    setCode('');
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)}>
      <div className="space-y-2">
        <Label htmlFor={`${id}-code`}>{t('code')}</Label>
        <Input
          id={`${id}-code`}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={9}
          required
          className="text-center font-mono text-lg tracking-[0.3em]"
          value={code}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-invalid` : undefined}
          onChange={(e) => setCode(e.target.value)}
        />
        {invalid ? (
          <p id={`${id}-invalid`} className="text-sm text-destructive">
            {t('invalid')}
          </p>
        ) : null}
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? tl('submitting') : t('submit')}
      </Button>
    </form>
  );
}
