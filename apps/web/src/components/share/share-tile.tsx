'use client';

import type { ShareItem } from '@shotx/shared';
import { Button, Checkbox, cn } from '@shotx/ui';
import { PlayIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface ShareTileProps {
  item: ShareItem;
  onOpen: () => void;
  /** Present when downloads are allowed: the selection checkbox. */
  selection?: { selected: boolean; onToggle: () => void };
  /** Present on face-search hits: the "not me" button. */
  onNotMe?: () => void;
  notMeBusy?: boolean;
}

/** A square photo cell of the share page: tap to open the lightbox. */
export function ShareTile({ item, onOpen, selection, onNotMe, notMeBusy }: ShareTileProps) {
  const t = useTranslations();
  return (
    <div
      className={cn(
        'relative flex h-full flex-col gap-1',
        selection?.selected && 'rounded-md ring-2 ring-primary',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={t('share.open', { name: item.name })}
      >
        {/* Signed CloudFront URL under /media: served by the CDN, not resized by the web server. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
        {item.mediaKind === 'video' ? (
          <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/60 p-1 text-white">
            <PlayIcon className="size-3.5" aria-label={t('share.video')} />
          </span>
        ) : null}
      </button>
      {selection !== undefined ? (
        <div className="absolute top-1.5 left-1.5">
          <Checkbox
            checked={selection.selected}
            onCheckedChange={selection.onToggle}
            aria-label={t('share.select', { name: item.name })}
            className="size-6 bg-background/90"
          />
        </div>
      ) : null}
      {onNotMe !== undefined ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full"
          disabled={notMeBusy}
          onClick={onNotMe}
          aria-label={t('results.notMeLabel', { name: item.name })}
        >
          {t('results.notMe')}
        </Button>
      ) : null}
    </div>
  );
}
