'use client';

import { DRIVE_ROUTES, type DriveFile, type DriveFolder } from '@shotx/shared';
import { Alert, Button, cn } from '@shotx/ui';
import { useMutation } from '@tanstack/react-query';
import {
  CheckIcon,
  ImageIcon,
  ImagesIcon,
  Loader2Icon,
  RotateCcwIcon,
  UploadIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ChangeEvent, useRef, useState } from 'react';
import { useApiClient } from '@/components/providers';
import { useDesigns } from '@/lib/design/queries';
import { uploadDesignImage } from '@/lib/design/upload';
import { useFolderChildren, useInvalidateDrive } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';

/** The event cover's aspect ratio (owner, 2026-11-16, ADR 0028): portrait 2:3. */
export const EVENT_COVER_ASPECT = 2 / 3;
/** The uploaded cover's size: never larger than the picked image, at most this tall. */
const COVER_MAX_HEIGHT = 1800;
const COVER_JPEG_QUALITY = 0.9;

/**
 * Crops an image to the middle 2:3 (the largest such box) and encodes it as a JPEG, at most
 * COVER_MAX_HEIGHT tall and never enlarged. In the browser only: the original never leaves it.
 */
export async function cropToCover(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = bitmap;
    const cropW = Math.min(width, Math.round(height * EVENT_COVER_ASPECT));
    const cropH = Math.min(height, Math.round(cropW / EVENT_COVER_ASPECT));
    const outH = Math.min(cropH, COVER_MAX_HEIGHT);
    const outW = Math.round(outH * EVENT_COVER_ASPECT);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('No 2d canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(
      bitmap,
      Math.round((width - cropW) / 2),
      Math.round((height - cropH) / 2),
      cropW,
      cropH,
      0,
      0,
      outW,
      outH,
    );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob === null ? reject(new Error('Encoding failed')) : resolve(blob)),
        'image/jpeg',
        COVER_JPEG_QUALITY,
      ),
    );
  } finally {
    bitmap.close();
  }
}

const isCoverCandidate = (item: { kind: string }): item is DriveFile =>
  item.kind === 'file' &&
  (item as DriveFile).mediaKind === 'image' &&
  (item as DriveFile).status === 'ready' &&
  (item as DriveFile).thumbUrl !== undefined;

type CoverChange = { coverAssetId: string } | { coverFileId: string } | { coverFileId: null };

/**
 * The event cover in the event editor (ADR 0028): a 2:3 preview, "upload a cover" (cropped to 2:3
 * in the browser, uploaded as a design image), "choose from the event's photos" and "automatic"
 * (the first photo). Each change is saved at once.
 */
export function EventCoverSection({ folder }: { folder: DriveFolder }) {
  const t = useTranslations('event.dialog');
  const describe = useErrorMessage();
  const api = useApiClient();
  const invalidate = useInvalidateDrive();
  const designs = useDesigns();
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const children = useFolderChildren(folder.id);
  const photos = children.items.filter(isCoverCandidate);
  const cover = folder.event?.coverThumbUrl ?? null;
  const custom = folder.coverAssetId !== null || folder.coverFileId !== null;

  const save = useMutation({
    mutationFn: (body: CoverChange) =>
      api.call(DRIVE_ROUTES.updateFolder, { params: { id: folder.id }, body }),
    onSuccess: invalidate,
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const maxBytes = designs.data?.limits.assetMaxBytes;
      if (maxBytes === undefined) throw new Error('Design limits not loaded');
      const cropped = await cropToCover(file);
      const stem = file.name.replace(/\.[^.]+$/, '') || 'cover';
      const asset = await uploadDesignImage(
        new File([cropped], `${stem}-cover.jpg`, { type: 'image/jpeg' }),
        { api, maxBytes },
      );
      await api.call(DRIVE_ROUTES.updateFolder, {
        params: { id: folder.id },
        body: { coverAssetId: asset.id },
      });
    },
    onSuccess: invalidate,
  });
  const busy = save.isPending || upload.isPending;

  function change(body: CoverChange) {
    setMessage(null);
    save.mutate(body, {
      onSuccess: () => {
        setPicking(false);
        setMessage({ kind: 'info', text: t('coverSaved') });
      },
      onError: (err) => setMessage({ kind: 'error', text: describe(err) }),
    });
  }

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setMessage(null);
    upload.mutate(file, {
      onSuccess: () => {
        setPicking(false);
        setMessage({ kind: 'info', text: t('coverSaved') });
      },
      onError: (err) => setMessage({ kind: 'error', text: describe(err) }),
    });
  }

  return (
    <section className="grid gap-3" aria-labelledby={`${folder.id}-cover`}>
      <h4 id={`${folder.id}-cover`} className="text-sm font-medium">
        {t('cover')}
      </h4>
      <div className="flex gap-4">
        <div
          className="relative flex aspect-[2/3] w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted sm:w-28"
          data-testid="event-cover-preview"
        >
          {cover !== null ? (
            // The cover's signed URL (CDN).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <ImageIcon className="size-6 text-muted-foreground" aria-hidden />
          )}
          {upload.isPending ? (
            <span className="absolute inset-0 flex items-center justify-center bg-background/70">
              <Loader2Icon className="size-5 animate-spin" aria-hidden />
            </span>
          ) : null}
        </div>
        <div className="grid min-w-0 content-start gap-2">
          <p className="text-xs text-muted-foreground">{t('coverHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || designs.data === undefined}
              onClick={() => input.current?.click()}
            >
              <UploadIcon aria-hidden />
              {upload.isPending ? t('coverUploading') : t('coverUpload')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              aria-expanded={picking}
              onClick={() => setPicking((p) => !p)}
            >
              <ImagesIcon aria-hidden />
              {t('coverPick')}
            </Button>
            {custom ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => change({ coverFileId: null })}
              >
                <RotateCcwIcon aria-hidden />
                {t('coverAuto')}
              </Button>
            ) : null}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-testid="event-cover-input"
            onChange={onFile}
          />
        </div>
      </div>
      {picking ? (
        children.isPending ? null : photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('coverEmpty')}</p>
        ) : (
          <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto p-0.5 sm:grid-cols-6">
            {photos.map((photo) => {
              const chosen = folder.coverAssetId === null && folder.coverFileId === photo.id;
              return (
                <button
                  key={photo.id}
                  type="button"
                  aria-pressed={chosen}
                  aria-label={t('coverChoose', { name: photo.name })}
                  disabled={busy}
                  onClick={() => change({ coverFileId: photo.id })}
                  className={cn(
                    'relative aspect-[2/3] overflow-hidden rounded-lg border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    chosen ? 'border-primary' : 'border-transparent',
                  )}
                >
                  {/* A signed thumbnail (CDN), shown as the 2:3 crop the cover gets. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.thumbUrl}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 size-full object-cover"
                  />
                  {chosen ? (
                    <span className="absolute top-1 right-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                      <CheckIcon className="size-3" aria-hidden />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )
      ) : null}
      {message !== null ? (
        <Alert variant={message.kind === 'error' ? 'destructive' : 'default'} role="status">
          {message.text}
        </Alert>
      ) : null}
    </section>
  );
}
