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

/** HTML of the download button: the label is escaped (it comes from the messages). */
export function downloadButtonHtml(label: string): string {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${escapeAttribute(label)}</span>`;
}

/** The parts of a PhotoSwipe instance that carry PhotoSwipe's own (English) accessibility text. */
interface LightboxDom {
  element?: HTMLElement;
  scrollWrap?: HTMLElement;
  mainScroll?: { itemHolders?: { el: HTMLElement }[] };
}

/**
 * Replaces PhotoSwipe's hard-coded English accessibility text (the dialog has no name, the
 * carousel and slides say "carousel" / "slide") with the UI language's.
 */
export function localizeLightbox(
  pswp: LightboxDom,
  labels: { dialog: string; carousel: string; slide: string },
): void {
  pswp.element?.setAttribute('aria-label', labels.dialog);
  pswp.scrollWrap?.setAttribute('aria-roledescription', labels.carousel);
  for (const holder of pswp.mainScroll?.itemHolders ?? []) {
    holder.el.setAttribute('aria-roledescription', labels.slide);
  }
}

/**
 * The lightbox's download button. `label`/`title` replace the "download" text (e.g. "save to Photos" on
 * iOS); `onShow` hears which photo is on screen (on open and after each swipe) so it can be
 * fetched ahead of the tap; `onClick` gets the photo and a setter for the button's text, which
 * goes back to `label` on the next swipe; `onClose` runs when the lightbox closes.
 */
export interface LightboxDownload {
  onClick: (item: ShareItem, setLabel: (label: string) => void) => void;
  onShow?: (item: ShareItem) => void;
  onClose?: () => void;
  label?: string;
  title?: string;
}

/**
 * Opens PhotoSwipe on a list of share items (loaded on first open, its own chunk). ADR 0011:
 * swipe left/right (PhotoSwipe's own gestures), previous/next arrows that stay visible on touch
 * screens too (globals.css), and, when `onDownload` is given, a clear download button for the
 * current photo in the top bar, before zoom and close (owner, 2026-11-13: it used to sit at the
 * bottom, where PhotoSwipe's button styles pushed it under the browser's toolbar). ADR 0022: on
 * phones globals.css moves the same button to the bottom centre (fixed, above the safe area).
 */
export function useLightbox(download?: LightboxDownload) {
  const t = useTranslations('lightbox');
  const current = useRef<{ destroy: () => void } | null>(null);
  const downloadRef = useRef(download);
  useEffect(() => {
    downloadRef.current = download;
  }, [download]);
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
        errorMsg: t('loadError'),
        arrowPrev: true,
        arrowNext: true,
        bgOpacity: 0.95,
      });
      const opened = downloadRef.current;
      if (opened !== undefined) {
        const label = opened.label ?? t('downloadShort');
        const title = opened.title ?? t('download');
        let button: HTMLElement | null = null;
        const setLabel = (text: string) => {
          if (button !== null) button.innerHTML = downloadButtonHtml(text);
        };
        pswp.on('uiRegister', () => {
          pswp.ui?.registerElement({
            name: 'download',
            title,
            ariaLabel: title,
            order: 9,
            isButton: true,
            appendTo: 'bar',
            className: 'pswp__download',
            html: downloadButtonHtml(label),
            onInit: (el) => {
              button = el;
            },
            onClick: () => {
              const item = items[pswp.currIndex];
              if (item !== undefined) downloadRef.current?.onClick(item, setLabel);
            },
          });
        });
        // `change` fires after each swipe; the first photo is announced after init() below.
        pswp.on('change', () => {
          setLabel(label);
          const item = items[pswp.currIndex];
          if (item !== undefined) downloadRef.current?.onShow?.(item);
        });
      }
      pswp.on('destroy', () => {
        if (current.current === pswp) current.current = null;
        downloadRef.current?.onClose?.();
      });
      current.current = pswp;
      pswp.init();
      // The DOM exists once init() has run.
      localizeLightbox(pswp, {
        dialog: t('dialog'),
        carousel: t('carousel'),
        slide: t('slide'),
      });
      const first = items[index];
      if (first !== undefined) downloadRef.current?.onShow?.(first);
    },
    [t],
  );
}
