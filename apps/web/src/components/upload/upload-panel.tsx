'use client';

import { Button, Progress } from '@shotx/ui';
import { CheckCircle2Icon, RotateCcwIcon, XCircleIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { type UploadEntry, useUploads } from './upload-context';

function EntryRow({ entry }: { entry: UploadEntry }) {
  const t = useTranslations('upload');
  const describe = useErrorMessage();
  const { cancel, retry } = useUploads();
  const failed = entry.status === 'error' || entry.status === 'rejected';
  return (
    <li className="space-y-1 py-2" data-status={entry.status}>
      <div className="flex items-center gap-2">
        {entry.status === 'complete' ? (
          <CheckCircle2Icon className="size-4 shrink-0 text-green-600" aria-hidden />
        ) : failed ? (
          <XCircleIcon className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm" title={entry.name}>
          {entry.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {entry.status === 'uploading'
            ? t('status.uploading', { percent: Math.round(entry.percent) })
            : t(`status.${entry.status}`)}
        </span>
        {entry.status === 'error' ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => retry(entry.id)}
            aria-label={t('retry', { name: entry.name })}
          >
            <RotateCcwIcon aria-hidden />
          </Button>
        ) : null}
        {entry.status !== 'complete' ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => cancel(entry.id)}
            aria-label={t('cancel', { name: entry.name })}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {entry.status === 'uploading' || entry.status === 'queued' ? (
        <Progress value={entry.percent} aria-label={entry.name} className="h-1.5" />
      ) : null}
      {failed && entry.error !== undefined ? (
        <p className="text-xs text-destructive" role="alert">
          {describe(entry.error)}
        </p>
      ) : null}
    </li>
  );
}

/** Upload queue: progress, Thai error messages, cancel (aborts and frees the quota) and retry. */
export function UploadPanel() {
  const t = useTranslations('upload');
  const { entries, clearFinished } = useUploads();
  if (entries.length === 0) return null;
  const done = entries.filter((e) => e.status === 'complete').length;
  return (
    <section
      aria-label={t('title')}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[45dvh] overflow-y-auto rounded-t-xl border bg-background p-4 shadow-lg sm:right-4 sm:bottom-4 sm:left-auto sm:w-96 sm:rounded-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{t('title')}</h2>
        <span className="text-sm text-muted-foreground" role="status">
          {t('summary', { done, total: entries.length })}
        </span>
      </div>
      <ul className="divide-y">
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </ul>
      <Button variant="outline" size="sm" className="mt-2 w-full" onClick={clearFinished}>
        {t('dismiss')}
      </Button>
    </section>
  );
}
