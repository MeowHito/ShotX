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

/** HTML of the print button (ADR 0031): the label is escaped (it comes from the messages). */
export function printButtonHtml(label: string): string {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg><span>${escapeAttribute(label)}</span>`;
}

/**
 * ADR 0031: the lightbox's print button, left of download, for the photos `isAvailable` accepts
 * (hidden on the others, e.g. videos). `isOrdered` switches its text to "ordered". `isBlocking`
 * is true while the print dialog is open over the lightbox: PhotoSwipe then ignores the keyboard
 * (Escape closes the dialog only, arrows don't swipe behind it).
 */
export interface LightboxPrint {
  onClick: (item: ShareItem) => void;
  isAvailable: (item: ShareItem) => boolean;
  isOrdered: (item: ShareItem) => boolean;
  isBlocking: () => boolean;
  /**
   * The small note shown while the lightbox is open (share.print.hint: "you can order 2 prints"), or null for none (the
   * viewer closed it). `onHintClose` runs when its × is tapped.
   */
  hint: string | null;
  onHintClose: () => void;
}

/** HTML of the print note: the text is escaped (it comes from the messages). */
export function printHintHtml(text: string, closeLabel: string): string {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg><span>${escapeAttribute(text)}</span><button type="button" class="pswp__print-hint-close" aria-label="${escapeAttribute(closeLabel)}"><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
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
export function useLightbox(download?: LightboxDownload, print?: LightboxPrint) {
  const t = useTranslations('lightbox');
  const tp = useTranslations('share.print');
  const current = useRef<{ destroy: () => void } | null>(null);
  const downloadRef = useRef(download);
  const printRef = useRef(print);
  /** Redraws the open lightbox's print button (the offer or the ordered photos changed). */
  const refreshPrint = useRef<(() => void) | null>(null);
  useEffect(() => {
    downloadRef.current = download;
  }, [download]);
  useEffect(() => {
    printRef.current = print;
    refreshPrint.current?.();
  }, [print]);
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
        // The print dialog (ADR 0031) opens over the lightbox and needs the focus.
        trapFocus: false,
      });
      // Print (ADR 0031): registered whenever the lightbox opens; shown only while the share
      // takes print orders and the photo can be printed.
      let printButton: HTMLElement | null = null;
      let printHint: HTMLElement | null = null;
      const drawPrint = () => {
        if (printHint !== null) {
          const text = printRef.current?.hint ?? null;
          printHint.style.display = text === null ? 'none' : '';
          const span = printHint.querySelector('span');
          if (text !== null && span !== null) span.textContent = text;
        }
        if (printButton === null) return;
        const item = items[pswp.currIndex];
        const offer = printRef.current;
        const shown = offer !== undefined && item !== undefined && offer.isAvailable(item);
        printButton.style.display = shown ? '' : 'none';
        if (shown) {
          printButton.innerHTML = printButtonHtml(
            offer.isOrdered(item) ? tp('orderedShort') : tp('submit'),
          );
        }
      };
      pswp.on('uiRegister', () => {
        pswp.ui?.registerElement({
          name: 'print',
          title: tp('title'),
          ariaLabel: tp('title'),
          order: 8,
          isButton: true,
          appendTo: 'bar',
          className: 'pswp__print',
          html: printButtonHtml(tp('submit')),
          onInit: (el) => {
            printButton = el;
            drawPrint();
          },
          onClick: () => {
            const item = items[pswp.currIndex];
            if (item !== undefined) printRef.current?.onClick(item);
          },
        });
        // The note under the bar: how many prints the photographer allows, with a ×.
        pswp.ui?.registerElement({
          name: 'print-hint',
          order: 30,
          isButton: false,
          appendTo: 'root',
          className: 'pswp__print-hint',
          html: printHintHtml(printRef.current?.hint ?? '', t('close')),
          onInit: (el) => {
            printHint = el;
            el.setAttribute('role', 'status');
            el.querySelector('button')?.addEventListener('click', () => {
              el.style.display = 'none';
              printRef.current?.onHintClose();
            });
            drawPrint();
          },
        });
      });
      pswp.on('change', drawPrint);
      pswp.on('keydown', (e) => {
        if (printRef.current?.isBlocking() === true) e.preventDefault();
      });
      refreshPrint.current = drawPrint;
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
        if (refreshPrint.current === drawPrint) refreshPrint.current = null;
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
    [t, tp],
  );
}
