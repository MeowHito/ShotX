'use client';

import { ADMIN_ROUTES, type AdminUser, accountNameSchema } from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { useApiClient } from '@/components/providers';
import { useErrorMessage } from '@/lib/errors/use-error-message';

/** "เปลี่ยนชื่อ": PATCH /admin/users/:id `name` (admins may rename themselves too). */
export function RenameDialog({
  user,
  onOpenChange,
  onDone,
}: {
  user: AdminUser | null;
  onOpenChange: (open: boolean) => void;
  onDone: (user: AdminUser, message: string) => void;
}) {
  const t = useTranslations('common');
  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')}>
        {user !== null ? (
          <RenameForm user={user} onClose={() => onOpenChange(false)} onDone={onDone} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: (user: AdminUser, message: string) => void;
}) {
  const t = useTranslations('renameDialog');
  const tc = useTranslations('common');
  const tu = useTranslations('createUser');
  const api = useApiClient();
  const errorMessage = useErrorMessage();
  const id = useId();
  const [name, setName] = useState(user.name ?? '');
  const [invalid, setInvalid] = useState(false);
  const mutation = useMutation({
    mutationFn: (next: string) =>
      api.call(ADMIN_ROUTES.updateUser, { params: { id: user.id }, body: { name: next } }),
    onSuccess: (updated) => onDone(updated, t('renamed')),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = accountNameSchema.safeParse(name);
    setInvalid(!parsed.success);
    if (parsed.success) mutation.mutate(parsed.data);
  }

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description', { email: user.email ?? '' })}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor={id}>{t('name')}</Label>
        <Input
          id={id}
          autoComplete="off"
          maxLength={200}
          value={name}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {invalid ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {tu('invalidName')}
          </p>
        ) : null}
      </div>
      {mutation.error !== null ? (
        <Alert variant="destructive">{errorMessage(mutation.error)}</Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
          {tc('cancel')}
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? tc('saving') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
