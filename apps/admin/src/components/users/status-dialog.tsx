'use client';

import { ADMIN_ROUTES, type AdminUser } from '@shotx/shared';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/components/providers';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useErrorMessage } from '@/lib/errors/use-error-message';

/**
 * Confirm, then disable or enable an account (PATCH /admin/users/:id `status`). Disabling signs
 * the person out everywhere and, for a photographer, takes their shares offline; files stay.
 * LAST_ADMIN and CANNOT_MODIFY_SELF come back as Thai messages in the dialog.
 */
export function StatusDialog({
  user,
  onOpenChange,
  onDone,
}: {
  user: AdminUser | null;
  onOpenChange: (open: boolean) => void;
  onDone: (user: AdminUser, message: string) => void;
}) {
  const t = useTranslations('statusDialog');
  const api = useApiClient();
  const errorMessage = useErrorMessage();
  const mutation = useMutation({
    mutationFn: (target: AdminUser) =>
      api.call(ADMIN_ROUTES.updateUser, {
        params: { id: target.id },
        body: { status: target.status === 'active' ? 'disabled' : 'active' },
      }),
    onSuccess: (updated) => {
      const email = updated.email ?? updated.name ?? '';
      onDone(
        updated,
        updated.status === 'disabled' ? t('disabled', { email }) : t('enabled', { email }),
      );
    },
  });

  const email = user?.email ?? user?.name ?? '';
  const disabling = user?.status === 'active';
  return (
    <ConfirmDialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) mutation.reset();
        onOpenChange(open);
      }}
      title={disabling ? t('disableTitle', { email }) : t('enableTitle', { email })}
      description={disabling ? t('disableDescription') : t('enableDescription')}
      confirmLabel={disabling ? t('disableConfirm') : t('enableConfirm')}
      destructive={disabling}
      pending={mutation.isPending}
      error={mutation.error === null ? null : errorMessage(mutation.error)}
      onConfirm={() => {
        if (user !== null) mutation.mutate(user);
      }}
    >
      {disabling && user?.role === 'photographer' ? (
        <p className="text-sm text-warning-foreground">{t('disablePhotographer')}</p>
      ) : null}
    </ConfirmDialog>
  );
}
