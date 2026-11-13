'use client';

import { Button } from '@shotx/ui';
import { ShieldAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { FormEvent } from 'react';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { useMe } from '@/lib/studio/queries';
import { useLogout } from './logout-button';

/**
 * ADR 0018: while an admin works in this photographer's account (act-as session, GET /me
 * `actingAdmin`), a bar across the top says so, that every change is recorded under the admin,
 * and offers the way out (sign out of this session; the admin's own admin session is untouched).
 */
export function ActAsBanner() {
  const t = useTranslations('studio.actAs');
  const me = useMe();
  const { formRef, busy, logout } = useLogout();
  const admin = me.data?.actingAdmin ?? null;
  if (admin === null) return null;
  const owner = me.data?.name ?? me.data?.email ?? '';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void logout();
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-amber-400 px-3 py-2 text-sm font-medium text-amber-950 sm:px-5"
    >
      <ShieldAlertIcon className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {t('banner', { admin: admin.name ?? admin.email ?? '', owner })}
        <span className="ml-2 font-normal opacity-80">{t('audited')}</span>
      </span>
      <form ref={formRef} action={AUTH_PATHS.logout} method="post" onSubmit={submit}>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={busy}
          className="h-8 border-amber-950/30 bg-amber-50 text-amber-950 hover:bg-amber-100"
        >
          {t('exit')}
        </Button>
      </form>
    </div>
  );
}
