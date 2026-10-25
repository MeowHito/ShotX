'use client';

import { type DriveItem, folderIdFromRef, type FolderRef } from '@shotx/shared';
import {
  Alert,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shotx/ui';
import {
  FolderInputIcon,
  FolderPlusIcon,
  MoreVerticalIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type DragEvent, useState } from 'react';
import { UploadButtons } from '@/components/upload/upload-buttons';
import { useUploads } from '@/components/upload/upload-context';
import {
  itemRef,
  useCreateFolder,
  useDriveUsage,
  useFolderChildren,
  useMoveItems,
  useRenameItem,
  useTrashItems,
} from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { filesFromDataTransfer } from '@/lib/upload/dropped-files';
import { Breadcrumbs } from './breadcrumbs';
import { DriveGrid } from './drive-grid';
import { ItemCard } from './item-card';
import { MoveDialog } from './move-dialog';
import { NameDialog } from './name-dialog';
import { folderHref } from './paths';

type Notice = { kind: 'info' | 'error'; text: string } | null;

/** The studio drive: one folder's contents with create, rename, move, trash and upload. */
export function DriveBrowser({ folderRef }: { folderRef: FolderRef }) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const folderId = folderIdFromRef(folderRef);
  const listing = useFolderChildren(folderRef);
  const usage = useDriveUsage();
  const uploads = useUploads();
  const createFolder = useCreateFolder();
  const renameItem = useRenameItem();
  const moveItems = useMoveItems();
  const trashItems = useTrashItems();

  const [selected, setSelected] = useState<ReadonlyMap<string, DriveItem>>(new Map());
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<DriveItem | null>(null);
  const [moving, setMoving] = useState<DriveItem[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [dragging, setDragging] = useState(false);

  const uploadsBlocked = usage.data?.uploadsBlockedBy ?? null;

  function toggle(item: DriveItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }

  async function trash(items: DriveItem[]) {
    try {
      await trashItems.mutateAsync(items.map(itemRef));
      setSelected(new Map());
      setNotice({ kind: 'info', text: t('drive.trashed', { count: items.length }) });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  async function move(targetId: string | null) {
    const items = moving ?? [];
    const result = await moveItems.mutateAsync({ items: items.map(itemRef), targetId });
    setSelected(new Map());
    if (result.failures.length === 0) {
      setNotice({ kind: 'info', text: t('drive.moved', { count: result.moved }) });
    } else {
      setNotice({
        kind: 'error',
        text: t('move.partialFailure', {
          count: result.failures.length,
          reason: describe(result.failures[0]?.error),
        }),
      });
    }
  }

  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = uploadsBlocked === null ? 'copy' : 'none';
    setDragging(true);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (uploadsBlocked !== null) {
      setNotice({ kind: 'error', text: t(`usage.blocked.${uploadsBlocked}`) });
      return;
    }
    void filesFromDataTransfer(event.dataTransfer).then((files) =>
      uploads.addFiles(files, folderId),
    );
  }

  const selection = [...selected.values()];

  function actionsFor(item: DriveItem) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 bg-background/80"
            aria-label={t('drive.itemActions', { name: item.name })}
          >
            <MoreVerticalIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(item)}>
            <PencilIcon aria-hidden />
            {t('drive.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMoving([item])}>
            <FolderInputIcon aria-hidden />
            {t('drive.move')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void trash([item])}>
            <Trash2Icon aria-hidden />
            {t('drive.moveToTrash')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      className={cn(
        'relative min-h-[60dvh] space-y-4',
        dragging && 'rounded-xl ring-2 ring-primary',
      )}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Breadcrumbs ancestors={listing.ancestors} current={listing.folder} />

      <div className="flex flex-wrap gap-2">
        <UploadButtons folderId={folderId} disabled={uploadsBlocked !== null} />
        <Button variant="outline" onClick={() => setCreating(true)}>
          <FolderPlusIcon aria-hidden />
          {t('drive.newFolder')}
        </Button>
      </div>

      {uploadsBlocked !== null ? (
        <Alert variant="warning">{t(`usage.blocked.${uploadsBlocked}`)}</Alert>
      ) : null}

      {notice !== null ? (
        <Alert
          variant={notice.kind === 'error' ? 'destructive' : 'default'}
          className="flex items-start justify-between gap-2"
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t('common.close')}>
            <XIcon className="size-4" aria-hidden />
          </button>
        </Alert>
      ) : null}

      {selection.length > 0 ? (
        <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm">
          <span className="px-1 text-sm font-medium" role="status">
            {t('drive.selectedCount', { count: selection.length })}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {selection.length === 1 ? (
              <Button size="sm" variant="outline" onClick={() => setRenaming(selection[0] ?? null)}>
                {t('drive.rename')}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setMoving(selection)}>
              {t('drive.move')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void trash(selection)}>
              {t('drive.moveToTrash')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Map())}
              aria-label={t('drive.clearSelection')}
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      {listing.isError ? (
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>
            {t('drive.loadError')}: {describe(listing.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void listing.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : listing.isPending ? (
        <p className="py-10 text-center text-muted-foreground" role="status">
          {t('common.loading')}
        </p>
      ) : listing.items.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed py-16 text-center">
          <p className="font-medium">{t('drive.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('drive.emptyHint')}</p>
        </div>
      ) : (
        <DriveGrid
          items={listing.items}
          label={listing.folder?.name ?? t('drive.root')}
          loadingMoreLabel={t('drive.loadingMore')}
          hasNextPage={listing.hasNextPage}
          isFetchingNextPage={listing.isFetchingNextPage}
          fetchNextPage={listing.fetchNextPage}
          renderItem={(item) => (
            <ItemCard
              item={item}
              selected={selected.has(item.id)}
              onToggleSelect={() => toggle(item)}
              href={item.kind === 'folder' ? folderHref(item.id) : null}
              actions={actionsFor(item)}
            />
          )}
        />
      )}

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10">
          <p className="rounded-lg bg-background px-6 py-4 font-medium shadow">
            {t('drive.dropHere')}
          </p>
        </div>
      ) : null}

      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('createFolder.title')}
        label={t('createFolder.nameLabel')}
        placeholder={t('createFolder.placeholder')}
        submitLabel={t('createFolder.submit')}
        onSubmit={(name) => createFolder.mutateAsync({ parentId: folderId, name })}
      />
      <NameDialog
        key={renaming?.id ?? 'none'}
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title={t('rename.title')}
        label={t('rename.nameLabel')}
        submitLabel={t('rename.submit')}
        initialName={renaming?.name}
        fileMime={renaming?.kind === 'file' ? renaming.mime : undefined}
        onSubmit={async (name) => {
          if (renaming === null) return;
          await renameItem.mutateAsync({ item: itemRef(renaming), name });
          setSelected(new Map());
        }}
      />
      <MoveDialog
        open={moving !== null}
        onOpenChange={(open) => !open && setMoving(null)}
        items={(moving ?? []).map(itemRef)}
        sourceFolderId={folderId}
        onMove={move}
      />
    </div>
  );
}
