'use client';

import {
  ErrorCode,
  opaqueTokenSchema,
  PACKAGES_SECTION_PATH,
  PASSWORD_MAX_LENGTH,
  passwordPolicyViolation,
  passwordTooWeakDetailsSchema,
} from '@shotx/shared';
import { Alert, Button, Label, PasswordInput } from '@shotx/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { ApiError } from '@/lib/api/errors';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { navigateTo } from '@/lib/browser/navigate';
import { messageForPasswordPolicy } from '@/lib/errors/messages';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { confirmFreeSignup } from '@/lib/packages/client';

/** Where the new photographer lands once the account exists (signed in). */
const AFTER_SIGNUP_PATH = '/studio';

/** The token of `#token=…` (never sent to a server by the browser), or null. */
function tokenFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return value !== null && opaqueTokenSchema.safeParse(value).success ? value : null;
}

/**
 * The link's token, read once per page load: the address bar is cleared right after, so later
 * reads must not see the empty fragment.
 */
let capturedToken: string | null | undefined;
function readLinkToken(): string | null {
  capturedToken ??= tokenFromHash(window.location.hash);
  return capturedToken;
}
const noSubscription = () => () => undefined;
/** Server render: unknown until the browser reads the fragment. */
const unknownOnServer = () => undefined;

type Field = 'new' | 'confirm' | null;

/** Codes after which the link can't work: used, expired, or sign-up switched off meanwhile. */
const LINK_DEAD: readonly ErrorCode[] = [ErrorCode.SIGNUP_LINK_INVALID, ErrorCode.NOT_FOUND];

/**
 * The page the Free sign-up email links to (ADR 0026): password + confirmation, checked against
 * the photographer policy first; the API then creates the account with the Free package and
 * answers a session, so the new photographer goes straight to the studio. The token lives in the
 * URL fragment and is removed from the address bar once read, as on the password-reset page.
 */
export function SignupConfirmForm({
  minLength: configuredMinLength,
  fetch: fetchImpl,
  initialHash,
}: {
  /** PHOTOGRAPHER_PASSWORD_MIN_LENGTH (clientPasswordPolicy). */
  minLength: number;
  fetch?: typeof fetch;
  /** Tests pass the fragment instead of window.location.hash. */
  initialHash?: string;
}) {
  const t = useTranslations('signup');
  const tp = useTranslations('password');
  const tErrors = useTranslations('errors');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const ids = { new: useId(), confirm: useId(), hint: useId(), error: useId() };
  // undefined: not read yet (the server render).
  const linkToken = useSyncExternalStore(noSubscription, readLinkToken, unknownOnServer);
  const token = initialHash !== undefined ? tokenFromHash(initialHash) : linkToken;
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [minLength, setMinLength] = useState(configuredMinLength);
  const [error, setError] = useState<{ text: string; field: Field } | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialHash === undefined && window.location.hash !== '') {
      // Keep the token out of the history, bookmarks and screenshots of the address bar.
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [initialHash]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || typeof token !== 'string') return;
    const reason = passwordPolicyViolation(next, { minLength, email: null });
    if (reason !== null) {
      const m = messageForPasswordPolicy(reason, minLength);
      setError({ text: tErrors(m.key, m.values as never), field: 'new' });
      return;
    }
    if (next !== confirm) {
      setError({ text: tp('mismatch'), field: 'confirm' });
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await confirmFreeSignup({ token, password: next }, fetchImpl);
      // Stay busy: the page is about to change.
      navigateTo(AFTER_SIGNUP_PATH);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && LINK_DEAD.includes(err.code)) {
        setLinkInvalid(true);
        return;
      }
      if (err instanceof ApiError && err.code === ErrorCode.PASSWORD_TOO_WEAK) {
        const details = passwordTooWeakDetailsSchema.safeParse(err.details);
        if (details.success) setMinLength(details.data.minLength);
      }
      setError({
        text: describe(err),
        field: err instanceof ApiError && err.code === ErrorCode.PASSWORD_TOO_WEAK ? 'new' : null,
      });
    }
  }

  if (token === undefined) return null;

  if (token === null || linkInvalid) {
    return (
      <div className="grid gap-4">
        <h1 className="text-2xl">{t('title')}</h1>
        <Alert variant="destructive">{t('linkInvalid')}</Alert>
        <Button asChild size="lg" className="h-12">
          <Link href={PACKAGES_SECTION_PATH}>{t('backToPackages')}</Link>
        </Button>
        <Link
          href={AUTH_PATHS.loginPage}
          className="text-center text-sm underline underline-offset-4"
        >
          {t('login')}
        </Link>
      </div>
    );
  }

  const invalid = (field: Field) => (error !== null && error.field === field ? true : undefined);
  const describedBy = (field: Field, ...extra: string[]) =>
    [...extra, ...(error !== null && error.field === field ? [ids.error] : [])].join(' ') ||
    undefined;

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <div className="space-y-1.5">
        <h1 className="text-2xl">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('body')}</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.new}>{tp('newPassword')}</Label>
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
          {tp('newHint', { minLength })}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.confirm}>{tp('confirm')}</Label>
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
      <Button type="submit" size="lg" className="h-12" disabled={busy}>
        {busy ? t('saving') : t('save')}
      </Button>
    </form>
  );
}
