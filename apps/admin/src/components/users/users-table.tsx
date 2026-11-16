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
import { useTotpEnabled } from '@/components/admin-settings';
import { useFormat } from '@/lib/i18n/use-format';

export type UserAction = 'rename' | 'resetPassword' | 'toggleStatus' | 'actAs';

/** Which row actions an account offers to the signed-in admin (the API enforces the same rules). */
export function availableActions(user: AdminUser, currentAdminId: string | null): UserAction[] {
  const self = currentAdminId !== null && user.id === currentAdminId;
  return [
    'rename',
    ...(user.passwordAccount && !self ? (['resetPassword'] as const) : []),
    ...(!self ? (['toggleStatus'] as const) : []),
    // ADR 0018: an active photographer's studio, as them.
    ...(user.role === 'photographer' && user.status === 'active' ? (['actAs'] as const) : []),
  ];
}

/**
 * ADR 0026: the photographer's package and whether it has run out at `now` (the api's `expired`,
 * or the expiry passed since the answer). Null without a package: unlimited (admin-created
 * photographers, and admins).
 */
export function packageStateOf(
  user: AdminUser,
  now: number,
): { pkg: NonNullable<AdminUser['package']>; expired: boolean } | null {
  const pkg = user.role === 'photographer' ? (user.package ?? null) : null;
  if (pkg === null) return null;
  return { pkg, expired: pkg.expired || Date.parse(pkg.expiresAt) <= now };
}

export function userDetailHref(id: string): string {
  return `/users/${id}`;
}

export function Badge({
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
  const format = useFormat();
  const [mountedAt] = useState(() => Date.now());
  const totp = useTotpEnabled();
  const now = nowProp ?? mountedAt;
  // ADR 0027: paid orders · packages + cash in THB; admins (null) and an older api (absent): –.
  const paidCell = (user: AdminUser) =>
    user.role === 'photographer' && user.ordersPaid != null && user.paidSatang != null
      ? t('paidSummary', { orders: user.ordersPaid, amount: format.satang(user.paidSatang) })
      : tc('none');

  return (
    <div className="overflow-x-auto rounded-xl border bg-background shadow-card">
      <table className="w-full min-w-[70rem] text-left text-sm">
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
            <th scope="col" className="px-4 py-3 text-right font-medium">
              {t('columns.photos')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('columns.package')}
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              {t('columns.paid')}
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
            const packageState = packageStateOf(user, now);
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
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={user.role === 'admin' ? 'primary' : 'neutral'}>
                      {tr(user.role)}
                    </Badge>
                    {user.selfSignup === true ? (
                      <Badge tone="primary">{t('selfSignup')}</Badge>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={user.status === 'active' ? 'neutral' : 'danger'}>
                      {ts(user.status)}
                    </Badge>
                    {user.mustChangePassword ? (
                      <Badge tone="warning">{t('mustChange')}</Badge>
                    ) : null}
                    {totp && user.totpEnrolled === false ? (
                      <Badge tone="warning">{t('totpPending')}</Badge>
                    ) : null}
                    {locked ? <Badge tone="warning">{t('locked')}</Badge> : null}
                  </div>
                </td>
                <td
                  className="px-4 py-3 text-right tabular-nums"
                  title={user.usedBytes !== null ? format.bytes(user.usedBytes) : undefined}
                >
                  {user.usedBytes !== null ? format.gigabytes(user.usedBytes) : tc('none')}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                  {user.lastSignInAt !== null ? format.dateTime(user.lastSignInAt) : t('never')}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {user.photoCount !== null ? format.count(user.photoCount) : tc('none')}
                </td>
                <td className="px-4 py-3">
                  {user.role !== 'photographer' ? (
                    tc('none')
                  ) : packageState === null ? (
                    <span className="text-muted-foreground">{t('package.unlimited')}</span>
                  ) : (
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{packageState.pkg.name}</span>
                        {packageState.expired ? (
                          <Badge tone="danger">{t('package.expired')}</Badge>
                        ) : null}
                      </div>
                      <div className="text-xs whitespace-nowrap text-muted-foreground">
                        {packageState.expired
                          ? t('package.expiredOn', {
                              date: format.dateTime(packageState.pkg.expiresAt),
                            })
                          : t('package.until', {
                              date: format.dateTime(packageState.pkg.expiresAt),
                            })}
                      </div>
                      <div className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        {t('package.photos', {
                          used: packageState.pkg.photosUsed,
                          limit: packageState.pkg.photoLimit,
                        })}
                      </div>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                  {paidCell(user)}
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
                      {actions.includes('actAs') ? (
                        <DropdownMenuItem onSelect={() => onAction('actAs', user)}>
                          {t('actions.actAs')}
                        </DropdownMenuItem>
                      ) : null}
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
