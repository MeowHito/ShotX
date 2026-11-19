'use client';

import type { ShareItem } from '@shotx/shared';
import { cn } from '@shotx/ui';
import { CheckIcon, PlayIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface ShareTileProps {
  item: ShareItem;
  /** The photo's box in the justified grid: its own aspect ratio (ADR 0011, no square crop). */
  size: { width: number; height: number };
  onOpen: () => void;
  /** Present when downloads are allowed: the round selection dot. */
  selection?: { selected: boolean; onToggle: () => void };
}

/**
 * A photo of the share page in its original aspect ratio: tap to open the lightbox, tap the
 * round dot to select (tap again to unselect).
 */
export function ShareTile({ item, size, onOpen, selection }: ShareTileProps) {
  const t = useTranslations();
  const selected = selection?.selected === true;
  return (
    <div className="relative flex flex-col gap-1">
      <button
        type="button"
        onClick={onOpen}
        style={{ height: size.height }}
        className={cn(
          'relative w-full overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          selected && 'ring-3 ring-primary ring-offset-1 ring-offset-background',
        )}
        aria-label={t('share.open', { name: item.name })}
      >
        {/* Signed CloudFront URL under /media: served by the CDN, not resized by the web server. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          width={item.width ?? undefined}
          height={item.height ?? undefined}
          className="absolute inset-0 size-full object-cover"
        />
        {item.mediaKind === 'video' ? (
          <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 p-1 text-white">
            <PlayIcon className="size-3.5" aria-label={t('share.video')} />
          </span>
        ) : null}
      </button>
      {selection !== undefined ? (
        // A 44 px touch target around a 26 px dot in the corner.
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t('share.select', { name: item.name })}
          onClick={selection.onToggle}
          className="group absolute top-0 right-0 flex size-11 items-start justify-end p-1.5 outline-none"
        >
          <span
            className={cn(
              'flex size-[26px] items-center justify-center rounded-full border-2 shadow-sm transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-white bg-black/25 text-transparent',
            )}
          >
            <CheckIcon className="size-4" strokeWidth={3} aria-hidden />
          </span>
        </button>
      ) : null}
    </div>
  );
}
