'use client';

import { Alert, Button, Skeleton } from '@shotx/ui';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { useTotpEnabled } from '@/components/admin-settings';
import { CashPayments } from '@/components/cash/cash-payments';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { formatDateTime, formatGigabytes } from '@/lib/format';
import { useUser } from '@/lib/users/queries';
import { UserActionDialogs, useUserActions } from './user-action-dialogs';
import { availableActions } from './users-table';
import type { PasswordUiConfig } from '@/lib/users/password';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** One account: its details, the same actions as the list, and (photographers) cash payments. */
export function UserDetail({
  userId,
  currentAdminId,
  passwords,
}: {
  userId: string;
  currentAdminId: string | null;
  passwords: PasswordUiConfig;
}) {
  const t = useTranslations('userDetail');
  const tu = useTranslations('users');
  const tr = useTranslations('roles');
  const ts = useTranslations('statuses');
  const tc = useTranslations('common');
  const errorMessage = useErrorMessage();
  const query = useUser(userId);
  const actions = useUserActions();
  const [now] = useState(() => Date.now());
  const totp = useTotpEnabled();

  const back = (
    <Link
      href="/users"
      className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ArrowLeftIcon className="size-4" aria-hidden />
      {t('back')}
    </Link>
  );

  if (query.isPending) {
    return (
      <div className="space-y-4">
        {back}
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        {back}
        <Alert variant="destructive">
          {t('loadError')}: {errorMessage(query.error)}
        </Alert>
      </div>
    );
  }

  const user = query.data;
  const available = availableActions(user, currentAdminId);
  const self = currentAdminId !== null && user.id === currentAdminId;
  const locked = user.lockedUntil !== null && Date.parse(user.lockedUntil) > now;

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        {back}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <p className="eyebrow">{tr(user.role)}</p>
            <h1 className="text-2xl break-all">{user.email ?? tu('noEmail')}</h1>
            <p className="text-sm text-muted-foreground">
              {user.name ?? tu('noName')}
              {self ? ` · ${tu('you')}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {available.includes('rename') ? (
              <Button variant="outline" onClick={() => actions.open('rename', user)}>
                {tu('actions.rename')}
              </Button>
            ) : null}
            {available.includes('resetPassword') ? (
              <Button variant="outline" onClick={() => actions.open('resetPassword', user)}>
                {tu('actions.resetPassword')}
              </Button>
            ) : null}
            {available.includes('toggleStatus') ? (
              <Button
                variant={user.status === 'active' ? 'destructive' : 'default'}
                onClick={() => actions.open('toggleStatus', user)}
              >
                {user.status === 'active' ? tu('actions.disable') : tu('actions.enable')}
              </Button>
            ) : null}
          </div>
        </div>
        <div aria-live="polite">
          {actions.message !== null ? <Alert>{actions.message}</Alert> : null}
        </div>
      </div>

      <section
        className="rounded-xl border bg-background px-5 py-3 shadow-card"
        aria-label={t('account')}
      >
        <dl className="divide-y">
          <Row label={tu('columns.status')}>
            {ts(user.status)}
            {user.mustChangePassword ? ` · ${tu('mustChange')}` : ''}
            {user.disabledAt !== null
              ? ` · ${t('disabledAt', { time: formatDateTime(user.disabledAt) })}`
              : ''}
          </Row>
          {locked && user.lockedUntil !== null ? (
            <Row label={tu('locked')}>
              {t('lockedUntil', { time: formatDateTime(user.lockedUntil) })}
            </Row>
          ) : null}
          <Row label={t('signIn')}>
            {user.passwordAccount ? t('passwordAccount') : t('oidcAccount')}
          </Row>
          {user.passwordAccount ? (
            <Row label={t('password')}>
              {user.mustChangePassword ? (
                <span className="font-medium text-warning-foreground" data-testid="password-state">
                  {t('passwordTemporary')}
                  {user.role === 'admin' ? ` ${t('adminFirstSignInPending')}` : ''}
                </span>
              ) : (
                <span data-testid="password-state">{t('passwordOwn')}</span>
              )}
            </Row>
          ) : null}
          {totp && user.totpEnrolled !== null ? (
            <Row label={t('totp')}>
              {user.totpEnrolled ? (
                <span data-testid="totp-state">{t('totpEnrolled')}</span>
              ) : (
                <span className="font-medium text-warning-foreground" data-testid="totp-state">
                  {t('totpPending')}
                </span>
              )}
            </Row>
          ) : null}
          <Row label={tu('columns.lastSignIn')}>
            {user.lastSignInAt !== null ? formatDateTime(user.lastSignInAt) : tu('never')}
          </Row>
          <Row label={tu('columns.created')}>
            {formatDateTime(user.createdAt)} ·{' '}
            {user.createdById !== null ? t('createdBy') : t('createdByCli')}
          </Row>
          <Row label={tu('columns.storage')}>
            {user.usedBytes !== null ? formatGigabytes(user.usedBytes) : tc('none')}
          </Row>
        </dl>
      </section>

      {user.role === 'photographer' ? <CashPayments photographer={user} /> : null}

      <UserActionDialogs actions={actions} passwords={passwords} />
    </div>
  );
}
