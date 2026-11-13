'use client';

import type { DriveFile } from '@shotx/shared';
import {
  Alert,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { CheckIcon, PencilIcon, SparkleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import { nameStem, numberedNames, renameSteps } from '@/lib/drive/bulk-rename';
import { type RenameFilesResult, useRenameFiles } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';

/** How long the "done" check shows before the dialog closes itself. */
const DONE_MS = 900;
/** Example names shown before the dots (then the last one). */
const PREVIEW_HEAD = 3;

/**
 * Newest first by upload time; files uploaded at the same moment keep the order they came in
 * (the listing's order: recent is already newest first).
 */
export function newestFirst(files: readonly DriveFile[]): DriveFile[] {
  return [...files].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RenameFilesDialogProps {
  /** The files to rename; null closes the dialog. */
  files: readonly DriveFile[] | null;
  onOpenChange: (open: boolean) => void;
  /** After the renames ran (some may have failed). */
  onDone?: (result: RenameFilesResult) => void;
}

/**
 * ADR 0023: rename one or many files from one name. A pencil mascot bobs over the form; the
 * photographer types a name, sees what the files will be called (several: `name(1)`, `name(2)`,
 * … newest first, each keeping its extension), and a check pops when it's done.
 */
export function RenameFilesDialog({ files, onOpenChange, onDone }: RenameFilesDialogProps) {
  return (
    <Dialog open={files !== null} onOpenChange={onOpenChange}>
      {files !== null ? (
        <RenameForm
          key={files.map((f) => f.id).join()}
          files={files}
          onOpenChange={onOpenChange}
          onDone={onDone}
        />
      ) : null}
    </Dialog>
  );
}

function RenameForm({
  files,
  onOpenChange,
  onDone,
}: {
  files: readonly DriveFile[];
  onOpenChange: (open: boolean) => void;
  onDone?: (result: RenameFilesResult) => void;
}) {
  const t = useTranslations('renameFiles');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const inputId = useId();
  const ordered = useMemo(() => newestFirst(files), [files]);
  const many = ordered.length > 1;
  const [name, setName] = useState(() => (many ? '' : nameStem(ordered[0]?.name ?? '')));
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [finished, setFinished] = useState<RenameFilesResult | null>(null);
  const rename = useRenameFiles();

  const planned = useMemo(
    () => (name.trim() === '' ? null : numberedNames(name, ordered)),
    [name, ordered],
  );

  // A clean finish closes by itself after the check has popped.
  useEffect(() => {
    if (finished === null || finished.failures.length > 0) return;
    const timer = setTimeout(() => onOpenChange(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [finished, onOpenChange]);

  function fail(text: string) {
    setError(text);
    setShake((n) => n + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (planned === null) {
      fail(name.trim() === '' ? t('empty') : t('invalid'));
      return;
    }
    setError(null);
    const steps = renameSteps(planned);
    setProgress({ done: 0, total: steps.filter((s) => s.final).length });
    try {
      const result = await rename.mutateAsync({
        steps,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setFinished(result);
      onDone?.(result);
      if (result.failures.length > 0) {
        fail(
          t('partial', {
            renamed: result.renamed,
            failed: result.failures.length,
            reason: describe(result.failures[0]?.error),
          }),
        );
      }
    } catch (err) {
      fail(describe(err));
    } finally {
      setProgress(null);
    }
  }

  const done = finished !== null && finished.failures.length === 0;
  const busy = progress !== null;
  const examples =
    planned === null
      ? []
      : planned.length <= PREVIEW_HEAD + 1
        ? planned.map((p) => p.to)
        : [...planned.slice(0, PREVIEW_HEAD).map((p) => p.to), '…', planned.at(-1)?.to ?? ''];

  return (
    <DialogContent closeLabel={tc('close')} className="overflow-x-hidden sm:max-w-md">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
        <div className="flex justify-center pt-1" aria-hidden>
          <div className="relative flex size-20 items-center justify-center">
            <span
              className={cn(
                'absolute inset-0 rounded-full bg-primary/10 transition-colors',
                done && 'bg-emerald-500/15',
              )}
            />
            {done ? (
              <span className="relative flex size-12 animate-snap-pop items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg">
                <CheckIcon className="size-7" strokeWidth={3} />
              </span>
            ) : (
              <span className="relative flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg motion-safe:animate-snap-bob">
                <PencilIcon className="size-6" />
              </span>
            )}
            <SparkleIcon className="absolute -top-1 right-1 size-4 text-amber-400 motion-safe:animate-snap-twinkle" />
            <SparkleIcon className="absolute bottom-2 -left-1 size-3 text-sky-400 [animation-delay:500ms] motion-safe:animate-snap-twinkle" />
            <SparkleIcon className="absolute top-3 -left-2 size-2.5 text-pink-400 [animation-delay:900ms] motion-safe:animate-snap-twinkle" />
          </div>
        </div>

        <DialogHeader className="text-center sm:text-center">
          <DialogTitle>
            {done
              ? t('doneTitle', { count: finished.renamed })
              : many
                ? t('titleMany', { count: ordered.length })
                : t('titleOne')}
          </DialogTitle>
          <DialogDescription>{done ? t('doneHint') : t('hint')}</DialogDescription>
        </DialogHeader>

        {done ? null : (
          <>
            <div className="grid gap-2">
              <Label htmlFor={inputId}>{t('label')}</Label>
              <Input
                id={inputId}
                value={name}
                placeholder={t('placeholder')}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                aria-invalid={error !== null}
                autoFocus
                autoComplete="off"
                enterKeyHint="done"
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">{t('extensionKept')}</p>
            </div>

            {examples.length > 0 ? (
              <div className="rounded-xl border border-dashed bg-sidebar p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  {many ? t('previewMany') : t('previewOne')}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={t('previewMany')}>
                  {examples.map((example, i) => (
                    <li
                      key={`${i}-${example}`}
                      className={cn(
                        'max-w-full truncate rounded-full bg-background px-2.5 py-0.5 text-xs shadow-card ring-1 ring-border',
                        example === '…' && 'bg-transparent shadow-none ring-0',
                      )}
                    >
                      {example}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {error !== null ? (
              // A new key replays the wiggle on every failed try.
              <Alert key={shake} variant="destructive" className="motion-safe:animate-snap-wiggle">
                {error}
              </Alert>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {finished !== null ? tc('close') : tc('cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t('progress', { done: progress.done, total: progress.total }) : t('submit')}
              </Button>
            </DialogFooter>
          </>
        )}
      </form>
    </DialogContent>
  );
}
