'use client';

import type { AdminUser } from '@shotx/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { applyUserUpdate } from '@/lib/users/queries';
import { RenameDialog } from './rename-dialog';
import { ResetPasswordDialog } from './reset-password-dialog';
import { StatusDialog } from './status-dialog';
import type { UserAction } from './users-table';
import type { PasswordUiConfig } from '@/lib/users/password';

/** Which action dialog is open, and for whom. */
export function useUserActions() {
  const [target, setTarget] = useState<{ action: UserAction; user: AdminUser } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const open = useCallback((action: UserAction, user: AdminUser) => {
    setMessage(null);
    setTarget({ action, user });
  }, []);
  return { target, setTarget, message, setMessage, open };
}

/** The rename, reset-password and disable/enable dialogs of the users list and detail pages. */
export function UserActionDialogs({
  actions,
  passwords,
}: {
  actions: ReturnType<typeof useUserActions>;
  passwords: PasswordUiConfig;
}) {
  const queryClient = useQueryClient();
  const { target, setTarget, setMessage } = actions;
  const userFor = (action: UserAction) => (target?.action === action ? target.user : null);
  const close = (open: boolean) => {
    if (!open) setTarget(null);
  };
  const done = (user: AdminUser, message: string) => {
    void applyUserUpdate(queryClient, user);
    setMessage(message);
    setTarget(null);
  };

  return (
    <>
      <RenameDialog user={userFor('rename')} onOpenChange={close} onDone={done} />
      <StatusDialog user={userFor('toggleStatus')} onOpenChange={close} onDone={done} />
      <ResetPasswordDialog
        user={userFor('resetPassword')}
        onOpenChange={close}
        passwords={passwords}
        // The dialog stays open to show the password once; only the data is refreshed.
        onReset={(user) => void applyUserUpdate(queryClient, user)}
      />
    </>
  );
}
