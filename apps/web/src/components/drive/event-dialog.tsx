'use client';

import { type DriveFolder, driveNameSchema, type OwnerShare } from '@shotx/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { LinkDesignPicker } from '@/components/shares/link-design-picker';
import { ShareForm } from '@/components/shares/share-form';
import { SavedToast } from '@/components/studio/saved-toast';
import { useRenameItem } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useCreateShare, useMe, useShares, useUpdateShare } from '@/lib/studio/queries';
import { EventStatusBadge } from './item-card';

/** The newest share of a folder that isn't revoked (shares come newest first). */
export function eventLink(shares: readonly OwnerShare[]): OwnerShare | null {
  return shares.find((s) => s.status !== 'revoked') ?? null;
}

/**
 * The event editor (ADR 0016): the event's name, then its link: publish / unpublish (the same link
 * either way), the link's page design (changed in place, ADR 0019; it replaced the cover picker,
 * owner 2026-11-13) and the link settings, or "create link and publish" when it has none.
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

function DetailsSection({ folder }: { folder: DriveFolder }) {
  const td = useTranslations('event.dialog');
  const tv = useTranslations('validation');
  const describe = useErrorMessage();
  const id = useId();
  const rename = useRenameItem();
  const [name, setName] = useState(folder.name);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const busy = rename.isPending;

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
      setMessage({ kind: 'info', text: td('saved') });
    } catch (err) {
      setMessage({ kind: 'error', text: describe(err) });
    }
  }

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
  /** The "saved" popup of the last settings save (its mode), keyed so each save pops again. */
  const [savedPopup, setSavedPopup] = useState<{ at: number; mode: OwnerShare['mode'] } | null>(
    null,
  );
  const tf = useTranslations('shareForm');
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
          <section className="grid gap-2">
            <h4 className="text-sm font-medium">{te('dialog.design')}</h4>
            <LinkDesignPicker share={link} />
          </section>
          <ShareForm
            key={`${link.id}-${shares.dataUpdatedAt}`}
            kind="edit"
            showDesign={false}
            share={link}
            faceSearchEnabled={faceSearchEnabled}
            onSubmit={async (changes) => {
              setMessage(null);
              await update.mutateAsync({ id: link.id, body: changes });
              // A popup, not the message above: the save button is far below it (owner, 2026-11-15).
              setSavedPopup({ at: Date.now(), mode: changes.mode ?? link.mode });
            }}
          />
        </>
      )}
      {savedPopup !== null ? (
        <SavedToast
          key={savedPopup.at}
          title={te('dialog.settingsSaved')}
          body={savedPopup.mode === 'face_only' ? tf('savedFaceOnly') : undefined}
          onDone={() => setSavedPopup(null)}
        />
      ) : null}
    </section>
  );
}
