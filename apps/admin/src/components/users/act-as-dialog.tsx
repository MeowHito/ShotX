'use client';

import { ADMIN_ROUTES, type AdminUser } from '@shotx/shared';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useApiClient } from '@/components/providers';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useErrorMessage } from '@/lib/errors/use-error-message';

/** Opens a tab now (in the click, so pop-up blockers allow it); null when the browser refuses. */
export type TabOpener = () => {
  location: { replace: (url: string) => void };
  close: () => void;
} | null;

const openBlankTab: TabOpener = () => {
  const tab = window.open('about:blank', '_blank');
  if (tab !== null) tab.opener = null;
  return tab;
};

/**
 * ADR 0018: confirm, then open the photographer's studio as them in a new tab. The tab is opened
 * in the click itself and sent to the one-time link once POST /admin/users/:id/act-as answers;
 * when the browser blocks it, the link is shown instead (it works once, within minutes).
 */
export function ActAsDialog({
  user,
  onOpenChange,
  onOpened,
  openTab = openBlankTab,
}: {
  user: AdminUser | null;
  onOpenChange: (open: boolean) => void;
  onOpened: (message: string) => void;
  /** Tests observe the tab. */
  openTab?: TabOpener;
}) {
  const t = useTranslations('actAsDialog');
  const api = useApiClient();
  const errorMessage = useErrorMessage();
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (target: AdminUser) => api.call(ADMIN_ROUTES.actAs, { params: { id: target.id } }),
  });
  const email = user?.email ?? user?.name ?? '';

  function confirm() {
    if (user === null) return;
    const tab = openTab();
    mutation.mutate(user, {
      onSuccess: ({ url }) => {
        if (tab === null) {
          setFallbackUrl(url);
          return;
        }
        tab.location.replace(url);
        onOpened(t('opened', { email }));
      },
      onError: () => tab?.close(),
    });
  }

  return (
    <ConfirmDialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) {
          mutation.reset();
          setFallbackUrl(null);
        }
        onOpenChange(open);
      }}
      title={t('title', { email })}
      description={t('description')}
      confirmLabel={t('confirm')}
      pending={mutation.isPending}
      error={mutation.error === null ? null : errorMessage(mutation.error)}
      onConfirm={confirm}
    >
      <p className="text-sm text-muted-foreground">{t('audited')}</p>
      {fallbackUrl !== null ? (
        <p className="space-y-1 text-sm">
          <span className="block">{t('blocked')}</span>
          <a
            href={fallbackUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline"
          >
            {t('openLink', { email })}
          </a>
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
