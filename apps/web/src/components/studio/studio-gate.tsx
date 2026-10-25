'use client';

import { Alert, Button, Input, Label } from '@shotx/ui';
import { CheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useBecomePhotographer, useMe } from '@/lib/studio/queries';

/**
 * Wraps the studio. After sign-in it asks `GET /me`; a user who isn't a photographer yet sees the
 * onboarding screen (POST /me/photographer starts the trial) instead of the drive, whose routes
 * would answer FORBIDDEN.
 */
export function StudioGate({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const me = useMe();
  if (me.isPending) {
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
  if (me.data.role !== 'photographer') return <Onboarding defaultName={me.data.name ?? ''} />;
  return <>{children}</>;
}

const POINTS = ['upload', 'share', 'stats'] as const;

export function Onboarding({ defaultName }: { defaultName: string }) {
  const to = useTranslations('onboarding');
  const describe = useErrorMessage();
  const inputId = useId();
  const become = useBecomePhotographer();
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      // The cached `me` becomes a photographer and StudioGate renders the drive.
      await become.mutateAsync(name.trim() || undefined);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mx-auto flex max-w-md flex-col gap-5 px-4 py-12"
      noValidate
    >
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">{to('title')}</h1>
        <p className="text-muted-foreground">{to('body')}</p>
      </div>
      <ul className="space-y-2">
        {POINTS.map((point) => (
          <li key={point} className="flex items-start gap-2 text-sm">
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            {to(`points.${point}`)}
          </li>
        ))}
      </ul>
      <div className="grid gap-2">
        <Label htmlFor={inputId}>{to('nameLabel')}</Label>
        <Input
          id={inputId}
          value={name}
          maxLength={200}
          placeholder={to('namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <Button type="submit" size="lg" disabled={become.isPending}>
        {become.isPending ? to('starting') : to('start')}
      </Button>
    </form>
  );
}
