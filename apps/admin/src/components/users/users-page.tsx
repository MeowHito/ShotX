'use client';

import {
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  type AccountRole,
  type AccountStatus,
} from '@shotx/shared';
import { Alert, Button, Input, Label, Skeleton } from '@shotx/ui';
import { useQueryClient } from '@tanstack/react-query';
import { SearchIcon, UserPlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { NativeSelect } from '@/components/ui/select';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { type UserFilters, userKeys, useUsersList } from '@/lib/users/queries';
import { CreateUserDialog } from './create-user-dialog';
import { UserActionDialogs, useUserActions } from './user-action-dialogs';
import { UsersTable } from './users-table';
import type { PasswordUiConfig } from '@/lib/users/password';

/**
 * The Users page (ADR 0010): search (email or name), role and status filters, cursor pagination
 * ("โหลดเพิ่ม"), create, and per-row rename / reset password / disable-enable. Every mutation goes
 * through a dialog and an audited /admin/* route.
 */
export function UsersPage({
  currentAdminId,
  passwords,
}: {
  currentAdminId: string | null;
  passwords: PasswordUiConfig;
}) {
  const t = useTranslations('users');
  const tr = useTranslations('roles');
  const ts = useTranslations('statuses');
  const tc = useTranslations('common');
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const id = useId();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<UserFilters>({});
  const [creating, setCreating] = useState(false);
  const actions = useUserActions();

  const list = useUsersList(filters);
  const users = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtered =
    filters.q !== undefined || filters.role !== undefined || filters.status !== undefined;

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const q = search.trim();
    setFilters((f) => ({ ...f, q: q === '' ? undefined : q.slice(0, 254) }));
  }

  function clearFilters() {
    setSearch('');
    setFilters({});
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button
          onClick={() => {
            actions.setMessage(null);
            setCreating(true);
          }}
        >
          <UserPlusIcon aria-hidden />
          {t('create')}
        </Button>
      </div>

      <div aria-live="polite">
        {actions.message !== null ? <Alert>{actions.message}</Alert> : null}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-sidebar p-3">
        <form
          role="search"
          className="flex min-w-64 flex-1 items-end gap-2"
          onSubmit={submitSearch}
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`${id}-q`}>{t('search')}</Label>
            <Input
              id={`${id}-q`}
              type="search"
              maxLength={254}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" aria-label={t('searchSubmit')}>
            <SearchIcon aria-hidden />
            <span className="hidden sm:inline">{t('searchSubmit')}</span>
          </Button>
        </form>
        <div className="w-40 space-y-1.5">
          <Label htmlFor={`${id}-role`}>{t('filterRole')}</Label>
          <NativeSelect
            id={`${id}-role`}
            value={filters.role ?? ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                role: e.target.value === '' ? undefined : (e.target.value as AccountRole),
              }))
            }
          >
            <option value="">{t('allRoles')}</option>
            {ACCOUNT_ROLES.map((r) => (
              <option key={r} value={r}>
                {tr(r)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="w-40 space-y-1.5">
          <Label htmlFor={`${id}-status`}>{t('filterStatus')}</Label>
          <NativeSelect
            id={`${id}-status`}
            value={filters.status ?? ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                status: e.target.value === '' ? undefined : (e.target.value as AccountStatus),
              }))
            }
          >
            <option value="">{t('allStatuses')}</option>
            {ACCOUNT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ts(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {filtered ? (
          <Button variant="ghost" onClick={clearFilters}>
            {t('clearFilters')}
          </Button>
        ) : null}
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label={tc('loading')}>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : list.isError && users.length === 0 ? (
        <Alert variant="destructive">
          <p>
            {t('loadError')}: {errorMessage(list.error)}
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>
            {tc('retry')}
          </Button>
        </Alert>
      ) : users.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <UsersTable users={users} currentAdminId={currentAdminId} onAction={actions.open} />
          {list.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
              </Button>
            </div>
          ) : null}
          {list.isFetchNextPageError ? (
            <Alert variant="destructive">{errorMessage(list.error)}</Alert>
          ) : null}
        </>
      )}

      <CreateUserDialog
        open={creating}
        onOpenChange={setCreating}
        passwords={passwords}
        onCreated={() =>
          void queryClient.invalidateQueries({ queryKey: [...userKeys.all, 'list'] })
        }
      />
      <UserActionDialogs actions={actions} passwords={passwords} />
    </div>
  );
}
