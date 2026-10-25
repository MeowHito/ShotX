'use client';

import type { TrashItem } from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shotx/ui';
import { RotateCcwIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { itemRef, useEmptyTrash, useRestoreItems, useTrash } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { formatBytes } from '@/lib/format';
import { DriveGrid } from './drive-grid';
import { ItemCard } from './item-card';

type Notice = { kind: 'info' | 'error'; text: string } | null;

/** Trash: restore selected items, or empty the trash for good. */
export function TrashView() {
  const t = useTranslations();
  const format = useFormatter();
  const describe = useErrorMessage();
  const trash = useTrash();
  const restore = useRestoreItems();
  const emptyTrash = useEmptyTrash();
  const [selected, setSelected] = useState<ReadonlyMap<string, TrashItem>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  function toggle(item: TrashItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }

  async function restoreSelected() {
    const items = [...selected.values()];
    try {
      await restore.mutateAsync(items.map(itemRef));
      setSelected(new Map());
      setNotice({ kind: 'info', text: t('trash.restored', { count: items.length }) });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  async function empty() {
    try {
      const result = await emptyTrash.mutateAsync();
      setSelected(new Map());
      setNotice({
        kind: 'info',
        text: t('trash.emptied', {
          files: result.files,
          folders: result.folders,
          bytes: formatBytes(result.bytes),
        }),
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('trash.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('trash.description')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={selected.size === 0 || restore.isPending}
            onClick={() => void restoreSelected()}
          >
            <RotateCcwIcon aria-hidden />
            {t('trash.restore')}
          </Button>
          <Button
            variant="destructive"
            disabled={trash.items.length === 0}
            onClick={() => setConfirming(true)}
          >
            <Trash2Icon aria-hidden />
            {t('trash.emptyTrash')}
          </Button>
        </div>
      </div>

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

      {selected.size > 0 ? (
        <p className="text-sm font-medium" role="status">
          {t('drive.selectedCount', { count: selected.size })}
        </p>
      ) : null}

      {trash.isError ? (
        <Alert variant="destructive">
          {t('drive.loadError')}: {describe(trash.error)}
        </Alert>
      ) : trash.isPending ? (
        <p className="py-10 text-center text-muted-foreground" role="status">
          {t('common.loading')}
        </p>
      ) : trash.items.length === 0 ? (
        <p className="rounded-xl border-2 border-dashed py-16 text-center text-muted-foreground">
          {t('trash.isEmpty')}
        </p>
      ) : (
        <DriveGrid
          items={trash.items}
          label={t('trash.title')}
          loadingMoreLabel={t('drive.loadingMore')}
          hasNextPage={trash.hasNextPage}
          isFetchingNextPage={trash.isFetchingNextPage}
          fetchNextPage={trash.fetchNextPage}
          renderItem={(item) => (
            <ItemCard
              item={item}
              selected={selected.has(item.id)}
              onToggleSelect={() => toggle(item)}
              href={null}
              subtitle={t('trash.purgeAt', {
                date: format.dateTime(new Date(item.purgeAt), { dateStyle: 'medium' }),
              })}
            />
          )}
        />
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('trash.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('trash.confirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={emptyTrash.isPending}
              onClick={() => void empty()}
            >
              {t('trash.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
