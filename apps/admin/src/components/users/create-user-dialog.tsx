'use client';

import {
  ACCOUNT_ROLES,
  ADMIN_ROUTES,
  type AccountRole,
  type AdminUser,
  accountEmailSchema,
  accountNameSchema,
} from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { useApiClient, useSessionEndedHandler } from '@/components/providers';
import { NativeSelect } from '@/components/ui/select';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { OneTimePassword } from './one-time-password';
import { PasswordField } from './password-field';
import { initialPasswordProblem, type PasswordUiConfig } from '@/lib/users/password';

/**
 * "สร้างผู้ใช้": email, name, role (admin or photographer) and the initial password. After the
 * API creates the account the password is shown once (OneTimePassword).
 *
 * The password lives only in this dialog's form state. The form is a child of DialogContent,
 * which Radix unmounts when the dialog closes, so closing drops it; the API call is made directly
 * (not through useMutation) so the password never enters TanStack Query's mutation cache.
 */
export function CreateUserDialog({
  open,
  onOpenChange,
  passwords,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  passwords: PasswordUiConfig;
  /** The new account (no password in it). */
  onCreated: (user: AdminUser) => void;
}) {
  const t = useTranslations('common');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        closeLabel={t('close')}
        // A click outside must not lose a password that is shown once.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <CreateUserForm
          passwords={passwords}
          onBusyChange={setBusy}
          onCreated={onCreated}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateUserForm({
  passwords,
  onBusyChange,
  onCreated,
  onClose,
}: {
  passwords: PasswordUiConfig;
  onBusyChange: (busy: boolean) => void;
  onCreated: (user: AdminUser) => void;
  onClose: () => void;
}) {
  const t = useTranslations('createUser');
  const tc = useTranslations('common');
  const tr = useTranslations('roles');
  const tp = useTranslations('passwordField');
  const te = useTranslations('errors');
  const to = useTranslations('oneTimePassword');
  const api = useApiClient();
  const sessionEnded = useSessionEndedHandler();
  const errorMessage = useErrorMessage();
  const id = useId();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AccountRole>('photographer');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    name?: string;
    password?: string;
  }>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Set once the account exists: the only place the password is kept, until the dialog closes. */
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  /** A changed password or role makes the last password error stale: show the hint again. */
  function clearPasswordError() {
    setFieldErrors(({ password: _stale, ...rest }) => rest);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const emailCheck = accountEmailSchema.safeParse(email);
    const nameCheck = accountNameSchema.safeParse(name);
    const errors = {
      ...(emailCheck.success ? {} : { email: t('invalidEmail') }),
      ...(nameCheck.success ? {} : { name: t('invalidName') }),
    };
    const problem =
      password === ''
        ? null
        : initialPasswordProblem(password, role, emailCheck.data ?? email, passwords);
    const passwordError =
      password === ''
        ? tp('required')
        : problem !== null
          ? te(`passwordPolicy.${problem.reason}`, { minLength: problem.minLength })
          : null;
    setFieldErrors(passwordError === null ? errors : { ...errors, password: passwordError });
    if (!emailCheck.success || !nameCheck.success || passwordError !== null) return;

    setPending(true);
    onBusyChange(true);
    setError(null);
    try {
      const user = await api.call(ADMIN_ROUTES.createUser, {
        body: { email: emailCheck.data, name: nameCheck.data, role, password },
      });
      setCreated({ email: user.email ?? emailCheck.data, password });
      // The form copy is cleared; the one-time panel holds the only remaining copy.
      setPassword('');
      onCreated(user);
    } catch (caught) {
      if (!sessionEnded(caught)) setError(errorMessage(caught));
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  }

  if (created !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('description')}</DialogDescription>
        </DialogHeader>
        <OneTimePassword
          email={created.email}
          password={created.password}
          heading={to('created', { email: created.email })}
          onDone={onClose}
        />
      </>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor={`${id}-email`}>{t('email')}</Label>
        <Input
          id={`${id}-email`}
          type="email"
          autoComplete="off"
          maxLength={254}
          value={email}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? `${id}-email-error` : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        {fieldErrors.email ? (
          <p id={`${id}-email-error`} className="text-sm text-destructive">
            {fieldErrors.email}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>{t('name')}</Label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          maxLength={200}
          value={name}
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? `${id}-name-error` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {fieldErrors.name ? (
          <p id={`${id}-name-error`} className="text-sm text-destructive">
            {fieldErrors.name}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-role`}>{t('role')}</Label>
        <NativeSelect
          id={`${id}-role`}
          value={role}
          aria-describedby={`${id}-role-hint`}
          onChange={(e) => {
            setRole(e.target.value as AccountRole);
            clearPasswordError();
          }}
        >
          {ACCOUNT_ROLES.map((r) => (
            <option key={r} value={r}>
              {tr(r)}
            </option>
          ))}
        </NativeSelect>
        <p id={`${id}-role-hint`} className="text-xs text-muted-foreground">
          {t(`roleHints.${role}`)} {t('roleFixed')}
        </p>
      </div>
      <PasswordField
        value={password}
        onChange={(value) => {
          setPassword(value);
          clearPasswordError();
        }}
        length={passwords.generatedLength}
        minLength={passwords.minLength[role]}
        email={email}
        error={fieldErrors.password ?? null}
      />
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          {tc('cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? tc('saving') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
