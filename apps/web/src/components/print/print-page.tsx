'use client';

import {
  ErrorCode,
  type OwnerPrintOrder,
  PRINT_DEVICE_LIMIT_MAX,
  PRINT_PAPER_SIZE_CODES,
  PRINT_ORDER_STATUSES,
  type PrintOrderStatus,
  type PrintPaperSize,
  type PrintSettings,
} from '@shotx/shared';
import { Alert, Button, Checkbox, cn, Input, Label } from '@shotx/ui';
import { CheckIcon, PrinterIcon, XIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { isApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { printPhoto } from '@/lib/print/print-job';
import {
  usePrintOrderAction,
  usePrintOrders,
  usePrintSettings,
  useUpdatePrintSettings,
} from '@/lib/print/queries';

/** This browser is the print station (per browser: only the computer with the printer). */
const STATION_STORAGE_KEY = 'snap.print-station';

const STATION_EVENT = 'snap:print-station';
/** Without storage (private mode) the switch still works until the page closes. */
let stationFallback = false;

function readStation(): boolean {
  try {
    return window.localStorage.getItem(STATION_STORAGE_KEY) === '1';
  } catch {
    return stationFallback;
  }
}

function writeStation(on: boolean): void {
  stationFallback = on;
  try {
    if (on) window.localStorage.setItem(STATION_STORAGE_KEY, '1');
    else window.localStorage.removeItem(STATION_STORAGE_KEY);
  } catch {
    // Private mode: stationFallback holds it.
  }
  window.dispatchEvent(new Event(STATION_EVENT));
}

function subscribeStation(onChange: () => void): () => void {
  window.addEventListener(STATION_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(STATION_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** This browser's station switch (off during SSR). */
function useStation(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeStation, readStation, () => false);
  return [on, writeStation];
}

/** Test seam: printing opens the browser's print dialog. */
export type PrintFn = typeof printPhoto;

/**
 * `/studio/print` (ADR 0031): print-order settings, this browser as the print station, and the
 * orders by status. Viewers order from the share page's printer button; with approval `auto`
 * orders are queued at once, otherwise the photographer allows each. A station prints queued
 * orders one at a time on this computer's printer while the page is open.
 */
export function PrintOrdersPage({ print = printPhoto }: { print?: PrintFn }) {
  const t = useTranslations('printStudio');
  const settings = usePrintSettings();
  return (
    <div className="w-full space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>
      {settings.data !== undefined && !settings.data.enabled ? (
        <Alert variant="warning">{t('disabledNotice')}</Alert>
      ) : null}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <OrdersSection print={print} />
        <div className="grid gap-5">
          <StationCard print={print} />
          {settings.data !== undefined ? <SettingsForm initial={settings.data} /> : null}
        </div>
      </div>
    </div>
  );
}

// --- settings ----------------------------------------------------------------------------------------

function SettingsForm({ initial }: { initial: PrintSettings }) {
  const tSet = useTranslations('printStudio.settings');
  const ts = useTranslations('share.print.sizes');
  const describe = useErrorMessage();
  const update = useUpdatePrintSettings();
  const [form, setForm] = useState(initial);
  const [limitText, setLimitText] = useState(String(initial.perDeviceLimit));
  const [saved, setSaved] = useState(false);
  const heading = useId();
  const limitId = useId();
  const limit = Number.parseInt(limitText, 10);
  const limitValid = Number.isInteger(limit) && limit >= 1 && limit <= PRINT_DEVICE_LIMIT_MAX;
  const sizesValid = form.paperSizes.length > 0;

  function change(next: Partial<PrintSettings>) {
    setSaved(false);
    setForm((f) => ({ ...f, ...next }));
  }

  function toggleSize(code: PrintPaperSize, on: boolean) {
    const sizes = on ? [...form.paperSizes, code] : form.paperSizes.filter((s) => s !== code);
    change({ paperSizes: PRINT_PAPER_SIZE_CODES.filter((c) => sizes.includes(c)) });
  }

  return (
    <section aria-labelledby={heading} className="studio-card space-y-4 p-4 sm:p-6">
      <h2 id={heading} className="text-lg">
        {tSet('title')}
      </h2>
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!limitValid || !sizesValid) return;
          update.mutate({ ...form, perDeviceLimit: limit }, { onSuccess: () => setSaved(true) });
        }}
      >
        <label className="flex items-start gap-3">
          <Checkbox
            checked={form.enabled}
            onCheckedChange={(v) => change({ enabled: v === true })}
            className="mt-0.5"
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">{tSet('enabled')}</span>
            <span className="text-xs text-muted-foreground">{tSet('enabledHint')}</span>
          </span>
        </label>

        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{tSet('approval')}</legend>
          {(['auto', 'manual'] as const).map((mode) => (
            <label
              key={mode}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                form.approval === mode ? 'border-primary bg-primary/5' : 'hover:bg-foreground/5',
              )}
            >
              <input
                type="radio"
                name="print-approval"
                value={mode}
                checked={form.approval === mode}
                onChange={() => change({ approval: mode })}
                className="mt-1 accent-[var(--color-primary)]"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">{tSet(mode)}</span>
                <span className="text-xs text-muted-foreground">{tSet(`${mode}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-1.5">
          <Label htmlFor={limitId}>{tSet('limit')}</Label>
          <Input
            id={limitId}
            type="number"
            inputMode="numeric"
            min={1}
            max={PRINT_DEVICE_LIMIT_MAX}
            value={limitText}
            aria-invalid={!limitValid}
            onChange={(e) => {
              setSaved(false);
              setLimitText(e.target.value);
            }}
            className="w-28"
          />
          <p className="text-xs text-muted-foreground">{tSet('limitHint')}</p>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{tSet('sizes')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {PRINT_PAPER_SIZE_CODES.map((code) => (
              <label key={code} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.paperSizes.includes(code)}
                  onCheckedChange={(v) => toggleSize(code, v === true)}
                />
                {ts(code)}
              </label>
            ))}
          </div>
          {!sizesValid ? <p className="text-xs text-destructive">{tSet('sizesRequired')}</p> : null}
        </fieldset>

        {update.isError ? <Alert variant="destructive">{describe(update.error)}</Alert> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={update.isPending || !limitValid || !sizesValid}>
            {update.isPending ? tSet('saving') : tSet('save')}
          </Button>
          {saved ? (
            <span role="status" className="text-sm text-muted-foreground">
              {tSet('saved')}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

// --- print station -----------------------------------------------------------------------------------

/**
 * While on, prints the oldest queued order, then the next, one at a time. Each is taken with
 * `onlyQueued` first, so a second station (another computer) never prints it twice.
 */
function StationCard({ print }: { print: PrintFn }) {
  const tSt = useTranslations('printStudio.station');
  const [on, setOn] = useStation();
  const [current, setCurrent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const describe = useErrorMessage();
  const queued = usePrintOrders('queued', on);
  const action = usePrintOrderAction();
  const busy = useRef(false);
  // Orders this station failed to take (another station took them, or they are gone).
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());

  const next = queued.data?.items.filter((o) => o.printUrl !== null && !skipped.has(o.id)).at(-1);

  const run = useCallback(
    async (order: OwnerPrintOrder) => {
      busy.current = true;
      setCurrent(order.orderNumber);
      try {
        const taken = await action.mutateAsync({ id: order.id, action: 'print', onlyQueued: true });
        if (taken.printUrl !== null) await print(taken.printUrl, taken.paperSize, taken);
        setError(null);
      } catch (err) {
        // Taken by another station (CONFLICT) or gone: skip it; anything else is shown.
        setSkipped((prev) => new Set(prev).add(order.id));
        if (!isApiError(err, ErrorCode.CONFLICT)) setError(describe(err));
      } finally {
        busy.current = false;
        setCurrent(null);
      }
    },
    [action, describe, print],
  );

  useEffect(() => {
    if (!on || busy.current || next === undefined) return;
    void run(next);
  }, [on, next, run]);

  return (
    <section className="studio-card space-y-3 p-4 sm:p-6">
      <label className="flex items-start gap-3">
        <Checkbox
          checked={on}
          onCheckedChange={(v) => {
            setOn(v === true);
          }}
          className="mt-0.5"
        />
        <span className="grid gap-0.5">
          <span className="text-sm font-medium">{tSt('title')}</span>
          <span className="text-xs text-muted-foreground">{tSt('hint')}</span>
        </span>
      </label>
      {on ? (
        <p role="status" className="flex items-center gap-2 text-sm text-primary">
          <PrinterIcon className="size-4 motion-safe:animate-pulse" aria-hidden />
          {current !== null ? tSt('printing', { number: String(current) }) : tSt('waiting')}
        </p>
      ) : null}
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <p className="text-xs text-muted-foreground">{tSt('kiosk')}</p>
    </section>
  );
}

// --- orders ------------------------------------------------------------------------------------------

function OrdersSection({ print }: { print: PrintFn }) {
  const t = useTranslations('printStudio');
  const describe = useErrorMessage();
  const [tab, setTab] = useState<PrintOrderStatus>('pending');
  const orders = usePrintOrders(tab);
  const counts = orders.data?.counts;
  return (
    <section className="studio-card min-w-0 space-y-4 p-4 sm:p-6">
      <div role="tablist" aria-label={t('title')} className="flex flex-wrap gap-2">
        {PRINT_ORDER_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={tab === status}
            onClick={() => setTab(status)}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === status
                ? 'border-primary bg-primary text-primary-foreground'
                : 'hover:bg-foreground/5',
            )}
          >
            {t(`tabs.${status}`)}
            {counts !== undefined ? (
              <span
                className={cn(
                  'min-w-5 rounded-full px-1.5 text-xs',
                  tab === status ? 'bg-primary-foreground/20' : 'bg-foreground/10',
                  status === 'pending' && counts.pending > 0 && tab !== status
                    ? 'bg-destructive text-white'
                    : null,
                )}
              >
                {counts[status]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {orders.isError ? (
        <Alert variant="destructive">
          {t('loadError')}: {describe(orders.error)}
        </Alert>
      ) : orders.data === undefined ? null : orders.data.items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t(`empty.${tab}`)}</p>
      ) : (
        <ul className="divide-y">
          {orders.data.items.map((order) => (
            <OrderRow key={order.id} order={order} print={print} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OrderRow({ order, print }: { order: OwnerPrintOrder; print: PrintFn }) {
  const t = useTranslations('printStudio');
  const ts = useTranslations('share.print.sizes');
  const format = useFormatter();
  const describe = useErrorMessage();
  const action = usePrintOrderAction();
  const [error, setError] = useState<string | null>(null);
  const gone = order.printUrl === null;

  async function doPrint() {
    setError(null);
    try {
      const taken = await action.mutateAsync({ id: order.id, action: 'print' });
      if (taken.printUrl !== null) await print(taken.printUrl, taken.paperSize, taken);
    } catch (err) {
      setError(describe(err));
    }
  }

  function decide(kind: 'approve' | 'reject') {
    setError(null);
    action.mutate({ id: order.id, action: kind }, { onError: (err) => setError(describe(err)) });
  }

  return (
    <li className="flex gap-3 py-3">
      <div className="size-16 shrink-0 overflow-hidden rounded-md bg-muted sm:size-20">
        {order.thumbUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={order.thumbUrl} alt="" className="size-full object-cover" loading="lazy" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-base font-bold">
            {t('order.number', { number: String(order.orderNumber) })}
          </span>
          <span className="truncate font-medium">{order.customerName ?? t('order.noName')}</span>
          <span className="rounded bg-foreground/10 px-1.5 text-xs font-semibold">
            {ts(order.paperSize)}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {order.eventName} · {order.fileName}
        </p>
        <p className="text-xs text-muted-foreground">
          {format.dateTime(new Date(order.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
          {' · '}
          {t('order.device', { label: order.deviceLabel })}
          {order.printCount > 0
            ? ` · ${t('order.printedTimes', { count: order.printCount })}`
            : null}
        </p>
        {gone ? <p className="text-xs text-destructive">{t('order.fileGone')}</p> : null}
        {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
        {order.status === 'pending' ? (
          <>
            <Button size="sm" onClick={() => decide('approve')} disabled={action.isPending || gone}>
              <CheckIcon aria-hidden />
              {t('actions.approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide('reject')}
              disabled={action.isPending}
            >
              <XIcon aria-hidden />
              {t('actions.reject')}
            </Button>
          </>
        ) : null}
        {order.status === 'queued' ? (
          <>
            <Button size="sm" onClick={() => void doPrint()} disabled={action.isPending || gone}>
              <PrinterIcon aria-hidden />
              {t('actions.print')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide('reject')}
              disabled={action.isPending}
            >
              <XIcon aria-hidden />
              {t('actions.reject')}
            </Button>
          </>
        ) : null}
        {order.status === 'printed' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void doPrint()}
            disabled={action.isPending || gone}
          >
            <PrinterIcon aria-hidden />
            {t('actions.reprint')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
