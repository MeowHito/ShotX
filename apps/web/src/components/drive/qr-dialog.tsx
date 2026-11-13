'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shotx/ui';
import { CopyIcon, DownloadIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '@/lib/studio/clipboard';

/** One event's link as a QR code (ADR 0016). */
export interface QrTarget {
  name: string;
  url: string;
  /** The link is unpublished: scanning it shows "not open for viewing" for now. */
  paused: boolean;
}

/** Pixels of the saved PNG (and the canvas): sharp enough to print on an A4 poster. */
export const QR_SIZE_PX = 1024;

/** A file name for the saved QR code: the event name without characters file systems refuse. */
export function qrFileName(name: string): string {
  const base =
    name
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'event';
  return `${base} QR.png`;
}

/**
 * The QR code of an event's link, drawn on a canvas in the browser (no request leaves the page),
 * with "save" (a PNG download) and "copy link". Error correction M with a quiet zone, black on
 * white whatever the theme, so phone cameras read it from a screen or a print.
 */
export function QrDialog({
  target,
  onOpenChange,
}: {
  target: QrTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      {target !== null ? (
        <DialogContent closeLabel={t('common.close')} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('event.qrFor', { name: target.name })}</DialogTitle>
            <DialogDescription className="break-all">{target.url}</DialogDescription>
          </DialogHeader>
          <QrBody target={target} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function QrBody({ target }: { target: QrTarget }) {
  const tq = useTranslations('event.qrDialog');
  const canvas = useRef<HTMLCanvasElement>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    QRCode.toCanvas(element, target.url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: QR_SIZE_PX,
      color: { dark: '#000000', light: '#ffffff' },
    }).then(
      () => {
        // The library sizes the canvas element to `width` px inline (1024): drop that so it
        // scales to its box; the bitmap stays 1024 px for "save as PNG".
        element.style.removeProperty('width');
        element.style.removeProperty('height');
      },
      () => setFailed(true),
    );
  }, [target.url]);

  function save() {
    const element = canvas.current;
    if (element === null) return;
    element.toBlob((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = qrFileName(target.name);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  async function copy() {
    try {
      await copyToClipboard(target.url);
      setMessage({ kind: 'info', text: tq('copied') });
    } catch {
      setMessage({ kind: 'error', text: target.url });
    }
  }

  return (
    <div className="grid gap-4">
      <div className="mx-auto w-full max-w-72 rounded-xl bg-white p-2 shadow-card">
        <canvas
          ref={canvas}
          role="img"
          aria-label={tq('alt', { url: target.url })}
          className="block aspect-square size-full"
          data-testid="event-qr"
        />
      </div>
      {target.paused ? <Alert variant="warning">{tq('pausedNote')}</Alert> : null}
      {message !== null ? (
        <Alert variant={message.kind === 'error' ? 'destructive' : 'default'} role="status">
          {message.text}
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={save} disabled={failed}>
          <DownloadIcon aria-hidden />
          {tq('save')}
        </Button>
        <Button variant="outline" onClick={() => void copy()}>
          <CopyIcon aria-hidden />
          {tq('copy')}
        </Button>
      </div>
    </div>
  );
}
