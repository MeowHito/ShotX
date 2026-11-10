'use client';

import type { AdminUser } from '@shotx/shared';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@shotx/ui';
import { EllipsisIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatDateTime, formatGigabytes } from '@/lib/format';

export type UserAction = 'rename' | 'resetPassword' | 'toggleStatus';

/** Which row actions an account offers to the signed-in admin (the API enforces the same rules). */
export function availableActions(user: AdminUser, currentAdminId: string | null): UserAction[] {
  const self = currentAdminId !== null && user.id === currentAdminId;
  return [
    'rename',
    ...(user.passwordAccount && !self ? (['resetPassword'] as const) : []),
    ...(!self ? (['toggleStatus'] as const) : []),
  ];
}

export function userDetailHref(id: string): string {
  return `/users/${id}`;
}

function Badge({
  tone,
  children,
}: {
  tone: 'neutral' | 'primary' | 'warning' | 'danger';
  children: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
        tone === 'primary' && 'bg-accent text-accent-foreground',
        tone === 'warning' && 'bg-warning/10 text-warning-foreground',
        tone === 'danger' && 'bg-destructive/10 text-destructive',
      )}
    >
      {children}
    </span>
  );
}

/** The users list: one row per account with its actions menu. */
export function UsersTable({
  users,
  currentAdminId,
  now: nowProp,
  onAction,
}: {
  users: readonly AdminUser[];
  currentAdminId: string | null;
  /** Epoch ms to judge `lockedUntil` against (tests); default: when the table mounted. */
  now?: number;
  onAction: (action: UserAction, user: AdminUser) => void;
}) {
  const t = useTranslations('users');
  const tr = useTranslations('roles');
  const ts = useTranslations('statuses');
  const tc = useTranslations('common');
  const [mountedAt] = useState(() => Date.now());
  const now = nowProp ?? mountedAt;

  return (
    <div className="overflow-x-auto rounded-xl border bg-background shadow-card">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">{t('tableLabel')}</caption>
        <thead className="border-b bg-sidebar text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('columns.email')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('columns.name')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('columns.role')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('columns.status')}
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              {t('columns.storage')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('columns.lastSignIn')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('columns.created')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              <span className="sr-only">{t('columns.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {users.map((user) => {
            const self = currentAdminId !== null && user.id === currentAdminId;
            const locked = user.lockedUntil !== null && Date.parse(user.lockedUntil) > now;
            const actions = availableActions(user, currentAdminId);
            const label = user.email ?? user.name ?? user.id;
            return (
              <tr key={user.id} className={cn(user.status === 'disabled' && 'bg-muted/40')}>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      href={userDetailHref(user.id)}
                      className="font-medium break-all text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {user.email ?? t('noEmail')}
                    </Link>
                    {self ? <Badge tone="primary">{t('you')}</Badge> : null}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {user.name ?? <span className="text-muted-foreground">{t('noName')}</span>}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={user.role === 'admin' ? 'primary' : 'neutral'}>
                    {tr(user.role)}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={user.status === 'active' ? 'neutral' : 'danger'}>
                      {ts(user.status)}
                    </Badge>
                    {user.mustChangePassword ? (
                      <Badge tone="warning">{t('mustChange')}</Badge>
                    ) : null}
                    {user.totpEnrolled === false ? (
                      <Badge tone="warning">{t('totpPending')}</Badge>
                    ) : null}
                    {locked ? <Badge tone="warning">{t('locked')}</Badge> : null}
                  </div>
                </td>
                <td
                  className="px-4 py-3 text-right tabular-nums"
                  title={
                    user.usedBytes !== null
                      ? `${user.usedBytes.toLocaleString('th-TH')} B`
                      : undefined
                  }
                >
                  {user.usedBytes !== null ? formatGigabytes(user.usedBytes) : tc('none')}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                  {user.lastSignInAt !== null ? formatDateTime(user.lastSignInAt) : t('never')}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                  {formatDateTime(user.createdAt)}
                </td>
                <td className="px-2 py-2 text-right">
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('actionsFor', { name: label })}
                      >
                        <EllipsisIcon aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={userDetailHref(user.id)}>{t('actions.details')}</Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {actions.includes('rename') ? (
                        <DropdownMenuItem onSelect={() => onAction('rename', user)}>
                          {t('actions.rename')}
                        </DropdownMenuItem>
                      ) : null}
                      {actions.includes('resetPassword') ? (
                        <DropdownMenuItem onSelect={() => onAction('resetPassword', user)}>
                          {t('actions.resetPassword')}
                        </DropdownMenuItem>
                      ) : null}
                      {actions.includes('toggleStatus') ? (
                        <DropdownMenuItem
                          variant={user.status === 'active' ? 'destructive' : 'default'}
                          onSelect={() => onAction('toggleStatus', user)}
                        >
                          {user.status === 'active' ? t('actions.disable') : t('actions.enable')}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
