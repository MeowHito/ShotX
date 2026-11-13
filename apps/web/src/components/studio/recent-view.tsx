'use client';

import { DRIVE_ITEMS_BATCH_MAX, type DriveFile } from '@shotx/shared';
import { Alert, Button, cn, Skeleton } from '@shotx/ui';
import { CheckSquareIcon, PencilIcon, SquareIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { DetailsPanel } from '@/components/drive/details-panel';
import { DriveGrid } from '@/components/drive/drive-grid';
import { ItemCard } from '@/components/drive/item-card';
import { RenameFilesDialog } from '@/components/drive/rename-files-dialog';
import { itemRef, useRecent, useRestoreItems, useTrashItems } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useLayoutPreference } from '@/lib/studio/view-preference';
import { useStudio } from './studio-context';

type Notice = {
  kind: 'info' | 'error';
  text: string;
  action?: { label: string; run: () => void };
} | null;

/** Loading placeholders shaped like the grid. */
export function GridSkeleton({ count = 10 }: { count?: number }) {
  const tc = useTranslations('common');
  return (
    <div role="status" aria-label={tc('loading')}>
      <span className="sr-only">{tc('loading')}</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="space-y-2 rounded-xl p-1.5">
            <Skeleton className="aspect-square w-full rounded-lg" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Recent (studio.recent): the newest files (GET /drive/recent). ADR 0023: files can be selected
 * (checkbox, or a tap once something is selected; "select all" takes every loaded file), renamed
 * together (RenameFilesDialog: name(1), name(2), … newest first) and moved to the trash with
 * undo. A tap with nothing selected opens the file's details.
 */
export function RecentView() {
  const t = useTranslations();
  const format = useFormatter();
  const describe = useErrorMessage();
  const studio = useStudio();
  const recent = useRecent({ processingPollMs: studio.config.processingPollMs });
  const trashItems = useTrashItems();
  const restoreItems = useRestoreItems();
  const [layout] = useLayoutPreference();
  const [details, setDetails] = useState<DriveFile | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<DriveFile[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  // Files that left the list (trashed elsewhere, a refetch) drop out of the selection.
  const selection = recent.items.filter((f) => selectedIds.has(f.id));
  const allSelected = recent.items.length > 0 && selection.length === recent.items.length;

  function toggle(file: DriveFile) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
  }
  const clearSelection = () => setSelectedIds(new Set());

  async function trash(targets: readonly DriveFile[]) {
    const refs = targets.map(itemRef);
    try {
      for (let i = 0; i < refs.length; i += DRIVE_ITEMS_BATCH_MAX) {
        await trashItems.mutateAsync(refs.slice(i, i + DRIVE_ITEMS_BATCH_MAX));
      }
      clearSelection();
      setNotice({
        kind: 'info',
        text: t('drive.trashed', { count: refs.length }),
        action: { label: t('drive.undo'), run: () => void undoTrash(refs) },
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  async function undoTrash(refs: ReturnType<typeof itemRef>[]) {
    try {
      for (let i = 0; i < refs.length; i += DRIVE_ITEMS_BATCH_MAX) {
        await restoreItems.mutateAsync(refs.slice(i, i + DRIVE_ITEMS_BATCH_MAX));
      }
      setNotice({ kind: 'info', text: t('trash.restored', { count: refs.length }) });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  return (
    <div className={cn('space-y-4', selection.length > 0 && 'pb-24 sm:pb-0')}>
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
            {t('recent.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('recent.description')}</p>
        </div>
        {recent.items.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 sm:h-9"
            onClick={() =>
              allSelected
                ? clearSelection()
                : setSelectedIds(new Set(recent.items.map((f) => f.id)))
            }
          >
            {allSelected ? <SquareIcon aria-hidden /> : <CheckSquareIcon aria-hidden />}
            {allSelected ? t('recent.selectNone') : t('recent.selectAll')}
          </Button>
        ) : null}
      </header>

      {notice !== null ? (
        <Alert
          variant={notice.kind === 'error' ? 'destructive' : 'default'}
          className="flex items-start justify-between gap-2"
        >
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{notice.text}</span>
            {notice.action !== undefined ? (
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                disabled={restoreItems.isPending}
                onClick={notice.action.run}
              >
                {notice.action.label}
              </Button>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t('common.close')}
            className="rounded p-0.5 hover:bg-muted"
          >
            <XIcon className="size-4" aria-hidden />
          </button>
        </Alert>
      ) : null}

      {selection.length > 0 ? (
        <div
          className={cn(
            'z-30 flex items-center gap-2 border bg-background/95 p-2 shadow-lg backdrop-blur',
            // Phones: a bottom action bar over the content; larger: a bar above the grid.
            'fixed inset-x-0 bottom-0 rounded-t-2xl pb-[max(0.5rem,env(safe-area-inset-bottom))]',
            'sm:sticky sm:top-[4.75rem] sm:bottom-auto sm:rounded-xl sm:pb-2',
          )}
        >
          <Button
            size="icon"
            variant="ghost"
            onClick={clearSelection}
            aria-label={t('drive.clearSelection')}
            className="size-11 sm:size-9"
          >
            <XIcon aria-hidden />
          </Button>
          <span className="px-1 text-sm font-medium" role="status">
            {t('drive.selectedCount', { count: selection.length })}
          </span>
          <div className="ml-auto flex gap-1 sm:gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-11 sm:h-9"
              onClick={() => setRenaming(selection)}
            >
              <PencilIcon className="sm:hidden" aria-hidden />
              <span className="max-sm:sr-only">{t('drive.rename')}</span>
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-11 sm:h-9"
              disabled={trashItems.isPending}
              onClick={() => void trash(selection)}
            >
              <Trash2Icon className="sm:hidden" aria-hidden />
              <span className="max-sm:sr-only">{t('recent.delete')}</span>
            </Button>
          </div>
        </div>
      ) : null}

      {recent.isError ? (
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>
            {t('recent.loadError')}: {describe(recent.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void recent.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : recent.isPending ? (
        <GridSkeleton />
      ) : recent.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-sidebar px-6 py-16 text-center">
          <p className="text-base font-medium">{t('recent.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('recent.emptyHint')}</p>
        </div>
      ) : (
        <DriveGrid
          items={recent.items}
          layout={layout}
          label={t('recent.title')}
          loadingMoreLabel={t('drive.loadingMore')}
          hasNextPage={recent.hasNextPage}
          isFetchingNextPage={recent.isFetchingNextPage}
          fetchNextPage={recent.fetchNextPage}
          renderItem={(file) => (
            <ItemCard
              item={file}
              layout={layout}
              selected={selectedIds.has(file.id)}
              selectionMode={selection.length > 0}
              checkboxAlwaysVisible
              onToggleSelect={() => toggle(file)}
              onPrimaryClick={(event) => {
                event.preventDefault();
                if (selection.length > 0 || event.metaKey || event.ctrlKey) toggle(file);
                else setDetails(file);
              }}
              onPreview={() => setDetails(file)}
              href={null}
              subtitle={t('recent.uploadedAt', {
                date: format.dateTime(new Date(file.createdAt), { dateStyle: 'medium' }),
              })}
            />
          )}
        />
      )}
      <DetailsPanel item={details} onOpenChange={(open) => !open && setDetails(null)} />
      <RenameFilesDialog
        files={renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
        onDone={(result) => {
          if (result.failures.length === 0) clearSelection();
        }}
      />
    </div>
  );
}
