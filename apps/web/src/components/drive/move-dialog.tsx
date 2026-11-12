'use client';

import { type DriveItemRef, folderRefFromId } from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shotx/ui';
import { ChevronRightIcon, FolderIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useFolderChildren } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';

export interface MoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: DriveItemRef[];
  /** Folder the items are in now; moving there is a no-op. Omitted: any folder can be chosen. */
  sourceFolderId?: string | null;
  onMove: (targetId: string | null, targetName: string) => Promise<unknown>;
  /** Replace the move wording (the dialog also picks folder sync's destination). */
  title?: string;
  confirmLabel?: string;
}

export function MoveDialog(props: MoveDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <FolderPicker {...props} /> : null}
    </Dialog>
  );
}

/** Browses folders from the root; folders being moved can't be opened or chosen. */
function FolderPicker({
  onOpenChange,
  items,
  sourceFolderId,
  onMove,
  title,
  confirmLabel,
}: MoveDialogProps) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const [current, setCurrent] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listing = useFolderChildren(folderRefFromId(current?.id ?? null));
  const moving = new Set(items.filter((i) => i.kind === 'folder').map((i) => i.id));

  // Folders come before files, so keep loading pages only while they are all folders.
  const folders = listing.items.filter((i) => i.kind === 'folder');
  const onlyFolders = folders.length === listing.items.length;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = listing;
  useEffect(() => {
    if (onlyFolders && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [onlyFolders, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const targetId = current?.id ?? null;
  const crumbs = [
    { id: null as string | null, name: t('drive.root') },
    ...listing.ancestors,
    ...(current ? [current] : []),
  ];

  async function move() {
    setBusy(true);
    setError(null);
    try {
      await onMove(targetId, current?.name ?? t('drive.root'));
      onOpenChange(false);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>{title ?? t('move.title', { count: items.length })}</DialogTitle>
      </DialogHeader>
      <nav aria-label={t('drive.breadcrumbLabel')}>
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          {crumbs.map((crumb, index) => (
            <li key={crumb.id ?? 'root'} className="flex items-center gap-1">
              {index < crumbs.length - 1 ? (
                <>
                  <button
                    type="button"
                    className="text-muted-foreground hover:underline"
                    onClick={() =>
                      setCurrent(crumb.id === null ? null : { id: crumb.id, name: crumb.name })
                    }
                  >
                    {crumb.name}
                  </button>
                  <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
                </>
              ) : (
                <span aria-current="page" className="font-semibold">
                  {crumb.name}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <ul className="max-h-72 min-h-24 overflow-y-auto rounded-md border">
        {listing.isPending ? (
          <li className="p-3 text-sm text-muted-foreground">{t('common.loading')}</li>
        ) : folders.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">{t('move.noSubfolders')}</li>
        ) : (
          folders.map((folder) => {
            const disabled = moving.has(folder.id);
            return (
              <li key={folder.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setCurrent({ id: folder.id, name: folder.name })}
                  aria-label={t('move.openFolder', { name: folder.name })}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm hover:bg-accent disabled:opacity-50"
                >
                  <FolderIcon className="size-5 shrink-0 text-amber-500" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  {disabled ? (
                    <span className="text-xs text-muted-foreground">{t('move.beingMoved')}</span>
                  ) : (
                    <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
                  )}
                </button>
              </li>
            );
          })
        )}
      </ul>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          disabled={
            busy ||
            (sourceFolderId !== undefined && targetId === sourceFolderId) ||
            (targetId !== null && moving.has(targetId))
          }
          onClick={() => void move()}
        >
          {confirmLabel ?? t('move.here')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
