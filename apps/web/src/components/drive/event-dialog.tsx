'use client';

import { type DriveFile, type DriveFolder, driveNameSchema, type OwnerShare } from '@shotx/shared';
import {
  Alert,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { CheckIcon, ImageIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { ShareForm } from '@/components/shares/share-form';
import { useFolderChildren, useRenameItem, useSetFolderCover } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useCreateShare, useMe, useShares, useUpdateShare } from '@/lib/studio/queries';
import { EventStatusBadge } from './item-card';

/** The newest share of a folder that isn't revoked (shares come newest first). */
export function eventLink(shares: readonly OwnerShare[]): OwnerShare | null {
  return shares.find((s) => s.status !== 'revoked') ?? null;
}

/**
 * The event editor (ADR 0016): the event's name and cover, then its link: publish / unpublish (the
 * same link either way) and the link settings, or "create link and publish" when it has none.
 */
export function EventDialog({
  folder,
  onOpenChange,
  onPublishedChange,
}: {
  folder: DriveFolder | null;
  onOpenChange: (open: boolean) => void;
  /** After publish or unpublish, for the drive's notice. */
  onPublishedChange?: (published: boolean, name: string) => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      {folder !== null ? (
        <DialogContent
          closeLabel={t('common.close')}
          aria-describedby={undefined}
          className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle>{t('event.dialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <DetailsSection key={folder.id} folder={folder} />
            <LinkSection folder={folder} onPublishedChange={onPublishedChange} />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const isCoverCandidate = (item: { kind: string }): item is DriveFile =>
  item.kind === 'file' &&
  (item as DriveFile).mediaKind === 'image' &&
  (item as DriveFile).status === 'ready' &&
  (item as DriveFile).thumbUrl !== undefined;

function DetailsSection({ folder }: { folder: DriveFolder }) {
  const td = useTranslations('event.dialog');
  const tv = useTranslations('validation');
  const describe = useErrorMessage();
  const id = useId();
  const rename = useRenameItem();
  const setCover = useSetFolderCover();
  const children = useFolderChildren(folder.id);
  const photos = children.items.filter(isCoverCandidate);
  const [name, setName] = useState(folder.name);
  const [cover, setCoverChoice] = useState<string | null>(folder.coverFileId);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const busy = rename.isPending || setCover.isPending;

  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = driveNameSchema.safeParse(name);
    if (!parsed.success) {
      setMessage({ kind: 'error', text: tv('invalidName') });
      return;
    }
    setMessage(null);
    try {
      if (parsed.data !== folder.name) {
        await rename.mutateAsync({ item: { kind: 'folder', id: folder.id }, name: parsed.data });
      }
      if (cover !== folder.coverFileId) {
        await setCover.mutateAsync({ folderId: folder.id, fileId: cover });
      }
      setMessage({ kind: 'info', text: td('saved') });
    } catch (err) {
      setMessage({ kind: 'error', text: describe(err) });
    }
  }

  const tile =
    'relative aspect-square overflow-hidden rounded-lg border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-4" noValidate>
      <h3 className="text-sm font-semibold">{td('details')}</h3>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>{td('name')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={255}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{td('cover')}</legend>
        <p className="text-xs text-muted-foreground">{td('coverHint')}</p>
        {children.isPending ? null : photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{td('coverEmpty')}</p>
        ) : (
          <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto p-0.5 sm:grid-cols-5">
            <button
              type="button"
              aria-pressed={cover === null}
              onClick={() => setCoverChoice(null)}
              className={cn(
                tile,
                'flex items-center justify-center bg-muted p-1 text-center text-xs text-muted-foreground',
                cover === null ? 'border-primary' : 'border-transparent',
              )}
            >
              <ImageIcon className="absolute top-1 left-1 size-3.5 opacity-60" aria-hidden />
              {td('coverAuto')}
            </button>
            {photos.map((photo) => (
              <button
                key={photo.id}
                type="button"
                aria-pressed={cover === photo.id}
                aria-label={td('coverChoose', { name: photo.name })}
                onClick={() => setCoverChoice(photo.id)}
                className={cn(tile, cover === photo.id ? 'border-primary' : 'border-transparent')}
              >
                {/* A signed thumbnail (CDN). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.thumbUrl}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 size-full object-cover"
                />
                {cover === photo.id ? (
                  <span className="absolute top-1 right-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                    <CheckIcon className="size-3" aria-hidden />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </fieldset>
      {message !== null ? (
        <Alert variant={message.kind === 'error' ? 'destructive' : 'default'} role="status">
          {message.text}
        </Alert>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {td('save')}
        </Button>
      </div>
    </form>
  );
}

function LinkSection({
  folder,
  onPublishedChange,
}: {
  folder: DriveFolder;
  onPublishedChange?: (published: boolean, name: string) => void;
}) {
  const te = useTranslations('event');
  const describe = useErrorMessage();
  const me = useMe();
  const shares = useShares({ folderId: folder.id });
  const create = useCreateShare();
  const update = useUpdateShare();
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const link = eventLink(shares.items);
  const faceSearchEnabled = me.data?.features.faceSearch ?? false;

  async function setPaused(paused: boolean) {
    if (link === null) return;
    setMessage(null);
    try {
      await update.mutateAsync({ id: link.id, body: { paused } });
      onPublishedChange?.(!paused, folder.name);
    } catch (err) {
      setMessage({ kind: 'error', text: describe(err) });
    }
  }

  return (
    <section className="grid gap-4 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{te('dialog.link')}</h3>
        {/* The listing's status until the shares arrive, then the share's own. */}
        <EventStatusBadge
          folder={
            link === null
              ? folder
              : {
                  ...folder,
                  event: {
                    coverThumbUrl: null,
                    link: { shareId: link.id, status: link.status, path: link.path, url: link.url },
                  },
                }
          }
        />
      </div>
      {message !== null ? (
        <Alert variant={message.kind === 'error' ? 'destructive' : 'default'} role="status">
          {message.text}
        </Alert>
      ) : null}
      {shares.isPending ? null : link === null ? (
        <ShareForm
          kind="create"
          targetType="folder"
          faceSearchEnabled={faceSearchEnabled}
          onSubmit={async (settings) => {
            await create.mutateAsync({
              target: { type: 'folder', folderId: folder.id },
              ...settings,
            });
            onPublishedChange?.(true, folder.name);
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-sidebar p-3">
            <span className="min-w-0 flex-1 truncate font-mono text-sm" title={link.url}>
              {link.url}
            </span>
            {link.status === 'paused' ? (
              <Button size="sm" onClick={() => void setPaused(false)} disabled={update.isPending}>
                {te('publish')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void setPaused(true)}
                disabled={update.isPending}
              >
                {te('unpublish')}
              </Button>
            )}
          </div>
          <ShareForm
            key={`${link.id}-${shares.dataUpdatedAt}`}
            kind="edit"
            share={link}
            faceSearchEnabled={faceSearchEnabled}
            onSubmit={async (changes) => {
              await update.mutateAsync({ id: link.id, body: changes });
              setMessage({ kind: 'info', text: te('dialog.settingsSaved') });
            }}
          />
        </>
      )}
    </section>
  );
}
