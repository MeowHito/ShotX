'use client';

import type {
  PrintPaperSize,
  ShareItem,
  SharePrintsResponse,
  ViewerPrintOrder,
} from '@shotx/shared';
import {
  Alert,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { CheckCircle2Icon, PrinterIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useCreatePrintOrder } from '@/lib/share/queries';

type Offer = NonNullable<SharePrintsResponse['offer']>;

/**
 * ADR 0031: the viewer orders a print of one photo: a paper size the photographer offers, an
 * optional name or bib number, and how many prints this device has left on the link. After
 * sending it shows the order number to give when picking the print up. The submit button first asks
 * to confirm (owner, 2026-11-19): the device's print quota, and that an order can't be changed.
 */
export function PrintDialog({
  token,
  item,
  offer,
  used,
  orders,
  onOpenChange,
}: {
  token: string;
  /** The photo to print; null closes the dialog. */
  item: ShareItem | null;
  offer: Offer;
  used: number;
  orders: readonly ViewerPrintOrder[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('share.print');
  const tc = useTranslations('common');
  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      {item !== null ? (
        <DialogContent
          closeLabel={tc('close')}
          // Opened from the lightbox (ADR 0031): above PhotoSwipe (--pswp-root-z-index 100000).
          className="z-[100010] max-h-[90dvh] overflow-y-auto"
          overlayClassName="z-[100010]"
          // Escape closes this dialog only: the lightbox under it listens on the document too.
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PrinterIcon className="size-5" aria-hidden />
              {t('title')}
            </DialogTitle>
            <DialogDescription>{t('body')}</DialogDescription>
          </DialogHeader>
          <PrintForm
            key={item.id}
            token={token}
            item={item}
            offer={offer}
            used={used}
            orders={orders}
            onDone={() => onOpenChange(false)}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function PrintForm({
  token,
  item,
  offer,
  used,
  orders,
  onDone,
}: {
  token: string;
  item: ShareItem;
  offer: Offer;
  used: number;
  orders: readonly ViewerPrintOrder[];
  onDone: () => void;
}) {
  const t = useTranslations('share.print');
  const describe = useErrorMessage();
  const create = useCreatePrintOrder(token);
  const [picked, setSize] = useState<PrintPaperSize>(offer.paperSizes[0] ?? '4r');
  // The offer may change while the dialog is open (refetch): fall back to a size on offer.
  const size = offer.paperSizes.includes(picked) ? picked : (offer.paperSizes[0] ?? picked);
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const sizeGroup = useId();
  const nameId = useId();

  const left = Math.max(0, offer.perDeviceLimit - used);
  const thisPhoto = orders.filter((o) => o.fileId === item.id);

  if (create.data !== undefined) {
    const { order } = create.data;
    return (
      <div className="grid gap-4 text-center" role="status">
        <CheckCircle2Icon className="mx-auto size-12 text-primary" aria-hidden />
        <div className="space-y-1">
          <p className="text-lg font-semibold">{t('done')}</p>
          <p className="text-2xl font-bold tracking-wide">
            {t('number', { number: String(order.orderNumber) })}
          </p>
          <p className="text-sm text-muted-foreground">
            {order.status === 'pending' ? t('waitApproval') : t('waitPrint')}
          </p>
        </div>
        <Button size="lg" className="rounded-full" onClick={onDone}>
          {t('close')}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (left === 0 || create.isPending) return;
        setConfirming(true);
      }}
    >
      <ConfirmPrint
        open={confirming}
        limit={offer.perDeviceLimit}
        sizeLabel={t(`sizes.${size}`)}
        name={name.trim()}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          create.mutate({ fileId: item.id, paperSize: size, customerName: name });
        }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.thumbUrl}
        alt=""
        className="mx-auto max-h-48 rounded-md object-contain"
        width={item.width ?? undefined}
        height={item.height ?? undefined}
      />
      <fieldset className="grid gap-2">
        <legend id={sizeGroup} className="mb-2 text-sm font-medium">
          {t('size')}
        </legend>
        <div role="radiogroup" aria-labelledby={sizeGroup} className="grid grid-cols-2 gap-2">
          {offer.paperSizes.map((code) => (
            <button
              key={code}
              type="button"
              role="radio"
              aria-checked={size === code}
              onClick={() => setSize(code)}
              className={cn(
                'min-h-11 rounded-lg border px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                size === code
                  ? 'border-primary bg-primary font-semibold text-primary-foreground'
                  : 'bg-background hover:bg-foreground/5',
              )}
            >
              {t(`sizes.${code}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>{t('name')}</Label>
        <Input
          id={nameId}
          value={name}
          maxLength={60}
          autoComplete="name"
          placeholder={t('namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {thisPhoto.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('ordered')}:{' '}
          {thisPhoto.map((o) => `#${o.orderNumber} ${t(`status.${o.status}`)}`).join(', ')}
        </p>
      ) : null}
      {create.isError ? (
        <Alert variant="destructive" role="alert">
          {describe(create.error)}
        </Alert>
      ) : null}
      <p
        className={cn(
          'text-center text-sm',
          left === 0 ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {left === 0
          ? t('limitReached', { limit: offer.perDeviceLimit })
          : t('remaining', { left, limit: offer.perDeviceLimit })}
      </p>
      <Button
        type="submit"
        size="lg"
        className="rounded-full"
        disabled={left === 0 || create.isPending}
      >
        <PrinterIcon aria-hidden />
        {create.isPending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}

/**
 * The small confirmation over the print dialog (owner, 2026-11-19): the device's print quota,
 * the order can't be changed afterwards, cancel or confirm. A dialog of its own, centred on every
 * screen (not a bottom sheet), so it shows wherever the form was scrolled; Escape or × cancel it
 * only. The confirm button takes the focus.
 */
function ConfirmPrint({
  open,
  limit,
  sizeLabel,
  name,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  limit: number;
  sizeLabel: string;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('share.print');
  const tc = useTranslations('common');
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {open ? (
        <DialogContent
          role="alertdialog"
          closeLabel={tc('close')}
          className="inset-auto top-1/2 left-1/2 z-[100020] w-[calc(100%-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 animate-fade-in gap-3 rounded-2xl p-5 pb-5 text-center sm:max-w-xs"
          overlayClassName="z-[100020]"
          onEscapeKeyDown={(e) => e.stopPropagation()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            confirmRef.current?.focus();
          }}
        >
          <PrinterIcon className="mx-auto size-8 text-primary" aria-hidden />
          <DialogTitle className="text-base">{t('confirmTitle')}</DialogTitle>
          <DialogDescription className="text-sm">{t('confirmBody', { limit })}</DialogDescription>
          <p className="text-sm font-medium">
            {t('confirmSize', { size: sizeLabel })}
            {name !== '' ? ` · ${name}` : null}
          </p>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button type="button" variant="outline" className="rounded-full" onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button ref={confirmRef} type="button" className="rounded-full" onClick={onConfirm}>
              {t('confirm')}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
