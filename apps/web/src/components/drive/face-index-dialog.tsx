'use client';

import type { DriveFolder } from '@shotx/shared';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
} from '@shotx/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useUpdateFaceIndex } from '@/lib/studio/queries';

/**
 * Face indexing of a folder subtree. Turning it on (or extending it) requires confirming that the
 * attendees were informed (PDPA checklist); turning it off is always allowed. Only offered while
 * `me.features.faceSearch` is true.
 */
export function FaceIndexDialog({
  folder,
  onOpenChange,
  onDone,
}: {
  folder: DriveFolder | null;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      {folder !== null ? (
        <DialogContent closeLabel={t('common.close')}>
          <FaceIndexForm key={folder.id} folder={folder} onDone={onDone} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function FaceIndexForm({ folder, onDone }: { folder: DriveFolder; onDone: (m: string) => void }) {
  const tf = useTranslations('faceIndex');
  const format = useFormatter();
  const describe = useErrorMessage();
  const checkboxId = useId();
  const update = useUpdateFaceIndex();
  const [informed, setInformed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the dialog opened; good enough to tell an active index from an expired one.
  const [openedAt] = useState(() => Date.now());
  const active =
    folder.faceIndexEnabled &&
    folder.faceIndexExpiresAt !== null &&
    Date.parse(folder.faceIndexExpiresAt) > openedAt;

  async function enable() {
    if (!informed) {
      setError(tf('informedRequired'));
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({
        id: folder.id,
        body: { enabled: true, attendeesInformedConfirmed: true },
      });
      onDone(tf('enabled'));
    } catch (err) {
      setError(describe(err));
    }
  }

  async function disable() {
    setError(null);
    try {
      await update.mutateAsync({ id: folder.id, body: { enabled: false } });
      onDone(tf('disabled'));
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{tf('title', { name: folder.name })}</DialogTitle>
        <DialogDescription>{tf('description')}</DialogDescription>
      </DialogHeader>
      <p className="text-sm font-medium" role="status">
        {active && folder.faceIndexExpiresAt !== null
          ? tf('statusOn', {
              date: format.dateTime(new Date(folder.faceIndexExpiresAt), { dateStyle: 'medium' }),
            })
          : tf('statusOff')}
      </p>
      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Checkbox
          id={checkboxId}
          checked={informed}
          onCheckedChange={(v) => setInformed(v === true)}
          className="mt-0.5"
        />
        <Label htmlFor={checkboxId} className="text-sm leading-relaxed font-normal">
          {tf('informed')}
        </Label>
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {active ? (
          <Button variant="outline" onClick={() => void disable()} disabled={update.isPending}>
            {tf('disable')}
          </Button>
        ) : null}
        <Button onClick={() => void enable()} disabled={update.isPending}>
          {active ? tf('extend') : tf('enable')}
        </Button>
      </div>
    </div>
  );
}
