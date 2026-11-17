'use client';

import {
  ErrorCode,
  PASSWORD_MAX_LENGTH,
  passwordPolicyViolation,
  passwordTooWeakDetailsSchema,
} from '@shotx/shared';
import { Alert, Button, Label, PasswordInput } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { requestPasswordChange } from '@/lib/auth/password-client';
import { messageForPasswordPolicy } from '@/lib/errors/messages';
import { useErrorMessage } from '@/lib/errors/use-error-message';

export type ChangePasswordMode = 'required' | 'voluntary';

/** Which field an error belongs to (for aria-invalid and focus). */
type Field = 'current' | 'new' | 'confirm' | null;

/**
 * Current password + new password + confirmation (ADR 0010). Checks the policy before sending
 * (passwordPolicyViolation with the photographer minimum, the email, and "same as current"), then
 * posts to web's own handler, which changes the password at the API and swaps the session cookies
 * for the new session. Server refusals (PASSWORD_INCORRECT, PASSWORD_TOO_WEAK, RATE_LIMITED for a
 * locked account) are worded by the one error map.
 * - `required`: the forced change of a temporary password; the current field is the password
 *   just typed at sign-in.
 * - `voluntary`: studio settings.
 */
export function ChangePasswordForm({
  mode,
  email,
  minLength: configuredMinLength,
  onChanged,
  fetch: fetchImpl,
}: {
  mode: ChangePasswordMode;
  /** The account's email, for the "contains your email" rule; null when unknown. */
  email: string | null;
  /** PHOTOGRAPHER_PASSWORD_MIN_LENGTH (clientPasswordPolicy). */
  minLength: number;
  /** After the API accepted the new password and the cookies hold the new session. */
  onChanged: () => void;
  /** Tests route the request to the handler. */
  fetch?: typeof fetch;
}) {
  const t = useTranslations('password');
  const tErrors = useTranslations('errors');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const ids = { current: useId(), new: useId(), confirm: useId(), hint: useId(), error: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  // The API's minimum wins once it has told us (PASSWORD_TOO_WEAK details).
  const [minLength, setMinLength] = useState(configuredMinLength);
  const [error, setError] = useState<{ text: string; field: Field } | null>(null);
  const [busy, setBusy] = useState(false);

  function policyError(): { text: string; field: Field } | null {
    if (current === '') return { text: t('currentMissing'), field: 'current' };
    const reason =
      passwordPolicyViolation(next, { minLength, email }) ??
      (next === current ? 'same_as_current' : null);
    if (reason !== null) {
      const m = messageForPasswordPolicy(reason, minLength);
      return { text: tErrors(m.key, m.values as never), field: 'new' };
    }
    if (next !== confirm) return { text: t('mismatch'), field: 'confirm' };
    return null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const local = policyError();
    setError(local);
    if (local !== null) return;
    setBusy(true);
    try {
      await requestPasswordChange({ currentPassword: current, newPassword: next }, fetchImpl);
      setCurrent('');
      setNext('');
      setConfirm('');
      setBusy(false);
      onChanged();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === ErrorCode.PASSWORD_TOO_WEAK) {
        const details = passwordTooWeakDetailsSchema.safeParse(err.details);
        if (details.success) setMinLength(details.data.minLength);
      }
      const field: Field =
        err instanceof ApiError && err.code === ErrorCode.PASSWORD_INCORRECT
          ? 'current'
          : err instanceof ApiError && err.code === ErrorCode.PASSWORD_TOO_WEAK
            ? 'new'
            : null;
      if (field === 'current') setCurrent('');
      setError({ text: describe(err), field });
    }
  }

  const invalid = (field: Field) => (error !== null && error.field === field ? true : undefined);
  const describedBy = (field: Field, ...extra: string[]) =>
    [...extra, ...(error !== null && error.field === field ? [ids.error] : [])].join(' ') ||
    undefined;

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <div className="grid gap-2">
        <Label htmlFor={ids.current}>
          {mode === 'required' ? t('currentTemporary') : t('current')}
        </Label>
        <PasswordInput
          id={ids.current}
          name="currentPassword"
          showLabel={tc('showPassword')}
          hideLabel={tc('hidePassword')}
          autoComplete="current-password"
          maxLength={1024}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          aria-invalid={invalid('current')}
          aria-describedby={describedBy('current')}
          className="h-12 md:h-10"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.new}>{t('newPassword')}</Label>
        <PasswordInput
          id={ids.new}
          name="newPassword"
          showLabel={tc('showPassword')}
          hideLabel={tc('hidePassword')}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-invalid={invalid('new')}
          aria-describedby={describedBy('new', ids.hint)}
          className="h-12 md:h-10"
        />
        <p id={ids.hint} className="text-xs text-muted-foreground">
          {t('newHint', { minLength })}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.confirm}>{t('confirm')}</Label>
        <PasswordInput
          id={ids.confirm}
          name="confirmPassword"
          showLabel={tc('showPassword')}
          hideLabel={tc('hidePassword')}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={invalid('confirm')}
          aria-describedby={describedBy('confirm')}
          className="h-12 md:h-10"
        />
      </div>
      {error !== null ? (
        <Alert id={ids.error} variant="destructive">
          {error.text}
        </Alert>
      ) : null}
      <Button type="submit" size="lg" className="h-12 md:h-10" disabled={busy}>
        {busy ? t('submitting') : mode === 'required' ? t('submitRequired') : t('submit')}
      </Button>
    </form>
  );
}
