'use client';

import type { ShareItem } from '@shotx/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import 'photoswipe/style.css';

/** Size used for items without dimensions (videos still processing, old files). */
const FALLBACK_SIZE = { width: 1600, height: 1200 };

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** One PhotoSwipe slide: the preview image, or an inline player for videos. */
export function slideFor(item: ShareItem) {
  const width = item.width ?? FALLBACK_SIZE.width;
  const height = item.height ?? FALLBACK_SIZE.height;
  if (item.mediaKind === 'video') {
    const poster = item.posterUrl ? ` poster="${escapeAttribute(item.posterUrl)}"` : '';
    return {
      html: `<div class="flex h-full items-center justify-center"><video class="max-h-full max-w-full" src="${escapeAttribute(item.previewUrl)}"${poster} controls playsinline preload="metadata"></video></div>`,
      width,
      height,
    };
  }
  return { src: item.previewUrl, msrc: item.thumbUrl, width, height, alt: item.name };
}

/**
 * Opens PhotoSwipe on a list of share items. PhotoSwipe is loaded on first open (its own chunk).
 * `onDownload`, when given, adds a download button for the current slide.
 */
export function useLightbox(onDownload?: (item: ShareItem) => void) {
  const t = useTranslations('lightbox');
  const current = useRef<{ destroy: () => void } | null>(null);
  const downloadRef = useRef(onDownload);
  useEffect(() => {
    downloadRef.current = onDownload;
  }, [onDownload]);
  useEffect(() => () => current.current?.destroy(), []);

  return useCallback(
    async (items: readonly ShareItem[], index: number) => {
      const { default: PhotoSwipe } = await import('photoswipe');
      current.current?.destroy();
      const pswp = new PhotoSwipe({
        dataSource: items.map(slideFor),
        index,
        closeTitle: t('close'),
        zoomTitle: t('zoom'),
        arrowPrevTitle: t('prev'),
        arrowNextTitle: t('next'),
        bgOpacity: 0.95,
      });
      if (downloadRef.current !== undefined) {
        pswp.on('uiRegister', () => {
          pswp.ui?.registerElement({
            name: 'download',
            title: t('download'),
            order: 8,
            isButton: true,
            html: '<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 32 32" width="32" height="32"><path d="M16 6v14m-6-6 6 6 6-6M8 25h16" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
            onClick: () => {
              const item = items[pswp.currIndex];
              if (item !== undefined) downloadRef.current?.(item);
            },
          });
        });
      }
      pswp.on('destroy', () => {
        if (current.current === pswp) current.current = null;
      });
      current.current = pswp;
      pswp.init();
    },
    [t],
  );
}
