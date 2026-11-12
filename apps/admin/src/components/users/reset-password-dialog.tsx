'use client';

import { ADMIN_ROUTES, type AdminUser } from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { useTotpEnabled } from '@/components/admin-settings';
import { useApiClient, useSessionEndedHandler } from '@/components/providers';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { OneTimePassword } from './one-time-password';
import { PasswordField } from './password-field';
import { initialPasswordProblem, type PasswordUiConfig } from '@/lib/users/password';

/**
 * "รีเซ็ตรหัสผ่าน": a new temporary password (typed or generated), confirmed by the submit
 * button, then shown once. Same rules as CreateUserDialog: the password lives only in the open
 * dialog's form, which unmounts on close, and never in the query cache.
 */
export function ResetPasswordDialog({
  user,
  onOpenChange,
  passwords,
  onReset,
}: {
  /** The account to reset; null closes the dialog. */
  user: AdminUser | null;
  onOpenChange: (open: boolean) => void;
  passwords: PasswordUiConfig;
  onReset: (user: AdminUser) => void;
}) {
  const t = useTranslations('common');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={user !== null} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent closeLabel={t('close')} onInteractOutside={(event) => event.preventDefault()}>
        {user !== null ? (
          <ResetPasswordForm
            user={user}
            passwords={passwords}
            onBusyChange={setBusy}
            onReset={onReset}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordForm({
  user,
  passwords,
  onBusyChange,
  onReset,
  onClose,
}: {
  user: AdminUser;
  passwords: PasswordUiConfig;
  onBusyChange: (busy: boolean) => void;
  onReset: (user: AdminUser) => void;
  onClose: () => void;
}) {
  const t = useTranslations('resetPassword');
  const tc = useTranslations('common');
  const tp = useTranslations('passwordField');
  const te = useTranslations('errors');
  const to = useTranslations('oneTimePassword');
  const api = useApiClient();
  const sessionEnded = useSessionEndedHandler();
  const errorMessage = useErrorMessage();
  const email = user.email ?? '';
  const totp = useTotpEnabled();

  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem =
      password === '' ? null : initialPasswordProblem(password, user.role, user.email, passwords);
    const invalid =
      password === ''
        ? tp('required')
        : problem !== null
          ? te(`passwordPolicy.${problem.reason}`, { minLength: problem.minLength })
          : null;
    setPasswordError(invalid);
    if (invalid !== null) return;
    setPending(true);
    onBusyChange(true);
    setError(null);
    try {
      const updated = await api.call(ADMIN_ROUTES.resetPassword, {
        params: { id: user.id },
        body: { password },
      });
      setRevealed(password);
      setPassword('');
      onReset(updated);
    } catch (caught) {
      if (!sessionEnded(caught)) setError(errorMessage(caught));
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  }

  if (revealed !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('description', { email })}</DialogDescription>
        </DialogHeader>
        <OneTimePassword
          email={email}
          password={revealed}
          heading={to('reset', { email })}
          onDone={onClose}
        />
      </>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description', { email })}</DialogDescription>
      </DialogHeader>
      {user.role === 'admin' && totp ? (
        <p className="text-sm text-muted-foreground">{t('adminNote')}</p>
      ) : null}
      <PasswordField
        value={password}
        onChange={(value) => {
          setPassword(value);
          setPasswordError(null);
        }}
        length={passwords.generatedLength}
        minLength={passwords.minLength[user.role]}
        email={email}
        error={passwordError}
      />
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          {tc('cancel')}
        </Button>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? tc('saving') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
