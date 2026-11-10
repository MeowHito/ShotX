'use client';

import { Alert, Button } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect } from 'react';
import { goToPasswordChange } from '@/components/providers';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useMe } from '@/lib/studio/queries';
import { LogoutButton } from './logout-button';

/**
 * Wraps the studio. After sign-in it asks `GET /me` (the one studio route a restricted session may
 * call) and only then renders the drive:
 * - `passwordChangeRequired` (a temporary password, ADR 0010): straight to the change-password
 *   page, before any drive route answers PASSWORD_CHANGE_REQUIRED;
 * - not a photographer (a LINE/Google viewer account): accounts come from admins only, so the
 *   page says to ask the admin for one. There is no self-serve upgrade any more.
 */
export function StudioGate({
  children,
  onPasswordChangeRequired = goToPasswordChange,
}: {
  children: ReactNode;
  /** Tests observe the redirect. */
  onPasswordChangeRequired?: () => void;
}) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const me = useMe();
  const mustChange = me.data?.passwordChangeRequired === true;
  useEffect(() => {
    if (mustChange) onPasswordChangeRequired();
  }, [mustChange, onPasswordChangeRequired]);

  if (me.isPending || mustChange) {
    return (
      <p className="py-16 text-center text-muted-foreground" role="status">
        {t('common.loading')}
      </p>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>
            {t('studio.loadError')}: {describe(me.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void me.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      </div>
    );
  }
  if (me.data.role !== 'photographer') return <NotPhotographer />;
  return <>{children}</>;
}

/** A signed-in account that isn't a photographer's: ask the admin (ADR 0010, no self sign-up). */
export function NotPhotographer() {
  const tn = useTranslations('notPhotographer');
  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-4 py-12">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">{tn('title')}</h1>
        <p className="text-muted-foreground">{tn('body')}</p>
      </div>
      <div>
        <LogoutButton />
      </div>
    </div>
  );
}
