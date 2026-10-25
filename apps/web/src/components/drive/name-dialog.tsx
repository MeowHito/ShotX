'use client';

import { driveNameSchema, renameKeepsFileType } from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { useErrorMessage } from '@/lib/errors/use-error-message';

export interface NameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  submitLabel: string;
  initialName?: string;
  placeholder?: string;
  /** For file renames: the new name must keep an extension of this MIME type. */
  fileMime?: string;
  onSubmit: (name: string) => Promise<unknown>;
}

/** Create-folder and rename dialog: validates the name with the shared schema before submitting. */
export function NameDialog(props: NameDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <NameForm {...props} /> : null}
    </Dialog>
  );
}

function NameForm({
  onOpenChange,
  title,
  label,
  submitLabel,
  initialName = '',
  placeholder,
  fileMime,
  onSubmit,
}: NameDialogProps) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const inputId = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = driveNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(t('validation.invalidName'));
      return;
    }
    if (fileMime !== undefined && !renameKeepsFileType(fileMime, parsed.data)) {
      setError(t('validation.extensionChanged'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(parsed.data);
      onOpenChange(false);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} aria-describedby={undefined}>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={inputId}>{label}</Label>
          <Input
            id={inputId}
            value={name}
            placeholder={placeholder}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error !== null}
            autoFocus
            autoComplete="off"
            enterKeyHint="done"
          />
        </div>
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
