'use client';

import {
  PACKAGE_CHECKOUT_RETURN_PATH,
  PACKAGES_SECTION_PATH,
  type PackageOrderView,
  type PackagePaymentMethod,
  type StartPackagePaymentResponse,
} from '@shotx/shared';
import { Alert } from '@shotx/ui';
import {
  ArrowLeftIcon,
  CreditCardIcon,
  DownloadIcon,
  Loader2Icon,
  QrCodeIcon,
  RefreshCwIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { navigateTo } from '@/lib/browser/navigate';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFormatSatang } from '@/lib/i18n/use-format';
import { fetchPackageOrder, startPackagePayment } from '@/lib/packages/client';

const BUTTON =
  'inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-[10px] px-5 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329] disabled:cursor-not-allowed disabled:opacity-55';
const PRIMARY = `${BUTTON} bg-[#092e50] text-white hover:bg-[#0c3d69]`;
const SECONDARY = `${BUTTON} border border-[#bfd0df] bg-white text-[#092e50] hover:bg-[#f3f7fb]`;
const MUTED = 'text-[#667888]';

const METHOD_ICONS = { qr: QrCodeIcon, card: CreditCardIcon } as const;

type QrPayment = Extract<StartPackagePaymentResponse, { method: 'qr' }>;

type Stage =
  | { kind: 'loading' }
  | { kind: 'choose'; order: PackageOrderView }
  | { kind: 'qr'; order: PackageOrderView; qr: QrPayment }
  | { kind: 'unavailable' };

/** Seconds left until `iso`, never negative. */
function secondsUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The pay page (ADR 0029): the order in this browser's cookie, paid with a PromptPay QR shown
 * here (the page polls GET /checkout/order every `intervalMs` until the order is no longer
 * pending, then goes to the return page) or mPAY's hosted card form. A paid or settled order goes
 * straight to the return page.
 */
export function PayCheckout({
  orderId,
  intervalMs,
  fetch: fetchImpl,
}: {
  orderId: string;
  intervalMs: number;
  fetch?: typeof fetch;
}) {
  const t = useTranslations('checkout.pay');
  const describe = useErrorMessage();
  const formatSatang = useFormatSatang();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [busy, setBusy] = useState<PackagePaymentMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The order: first load, then polled while a QR is shown.
  const polling = stage.kind === 'qr';
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const order = await fetchPackageOrder(fetchImpl);
        if (stopped) return;
        if (order.status !== 'pending' && order.status !== 'failed') {
          navigateTo(PACKAGE_CHECKOUT_RETURN_PATH);
          return;
        }
        if (order.status === 'failed' && order.paymentMethods.length === 0) {
          navigateTo(PACKAGE_CHECKOUT_RETURN_PATH);
          return;
        }
        setStage((current) => {
          if (current.kind === 'qr') return { ...current, order };
          if (current.kind !== 'loading') return current;
          return order.paymentMethods.length === 0
            ? { kind: 'unavailable' }
            : { kind: 'choose', order };
        });
      } catch (err) {
        if (stopped) return;
        setStage((current) => (current.kind === 'loading' ? { kind: 'unavailable' } : current));
        if (!polling) setError(describe(err));
      }
      if (polling && !stopped) timer = setTimeout(() => void load(), intervalMs);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [polling, intervalMs, fetchImpl, describe]);

  // The QR's countdown.
  useEffect(() => {
    if (stage.kind !== 'qr') return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [stage.kind]);

  async function pay(order: PackageOrderView, method: PackagePaymentMethod) {
    setBusy(method);
    setError(null);
    try {
      const start = await startPackagePayment({ orderId, method }, fetchImpl);
      if (start.method === 'card') {
        // Stay busy: the card form is loading.
        navigateTo(start.redirectUrl);
        return;
      }
      setStage({ kind: 'qr', order, qr: start });
      setBusy(null);
    } catch (err) {
      setBusy(null);
      setError(describe(err));
    }
  }

  if (stage.kind === 'loading') {
    return (
      <div className="grid justify-items-center gap-3 py-6" role="status">
        <Loader2Icon className="size-10 animate-spin text-[#0875e9]" aria-hidden />
        <p className={MUTED}>{t('loading')}</p>
      </div>
    );
  }

  if (stage.kind === 'unavailable') {
    return (
      <div className="grid justify-items-center gap-3 text-center">
        <h1 className="text-2xl font-bold text-[#092e50]">{t('title')}</h1>
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
        <p className={MUTED}>{t('unavailable')}</p>
        <Link href={PACKAGES_SECTION_PATH} className={SECONDARY}>
          {t('backToPackages')}
        </Link>
      </div>
    );
  }

  const { order } = stage;
  const summary = (
    <div className="rounded-xl bg-[#f3f7fb] px-4 py-3 text-center">
      <p className="text-sm text-[#14293b]">{t('package', { name: order.packageName })}</p>
      <p className="text-2xl font-bold text-[#092e50]">{formatSatang(order.totalSatang)}</p>
      <p className={`text-xs ${MUTED}`}>{t('vatIncluded')}</p>
      {order.coupon !== null ? (
        <p className="mt-1 text-xs font-semibold text-[#0f7a43]">
          {t('coupon', {
            code: order.coupon.code,
            total: formatSatang(order.coupon.listTotalSatang),
          })}
        </p>
      ) : null}
    </div>
  );

  if (stage.kind === 'qr') {
    const left = secondsUntil(stage.qr.expiresAt, now);
    const expired = left === 0;
    return (
      <div className="grid gap-4 text-center">
        <h1 className="text-2xl font-bold text-[#092e50]">{t('qrTitle')}</h1>
        {summary}
        <div className="relative mx-auto">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the gateway */}
          <img
            src={stage.qr.qrImage}
            alt={t('qrAlt')}
            width={240}
            height={240}
            className={`size-60 rounded-lg border border-[#dce6ee] bg-white p-2 ${expired ? 'opacity-20' : ''}`}
          />
        </div>
        {expired ? (
          <p className="font-semibold text-[#dc2626]" role="status">
            {t('qrExpired')}
          </p>
        ) : (
          <>
            <p className={MUTED}>{t('qrHint')}</p>
            <p
              className="flex items-center justify-center gap-2 text-sm text-[#092e50]"
              role="status"
            >
              <Loader2Icon className="size-4 animate-spin text-[#0875e9]" aria-hidden />
              {t('qrWaiting', { time: mmss(left) })}
            </p>
          </>
        )}
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
        <div className="grid gap-2.5 sm:grid-cols-2">
          {expired ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void pay(order, 'qr')}
              className={PRIMARY}
            >
              <RefreshCwIcon className="size-4" aria-hidden />
              {busy === 'qr' ? t('starting') : t('qrNew')}
            </button>
          ) : (
            <a href={stage.qr.qrImage} download="snap-promptpay-qr.png" className={PRIMARY}>
              <DownloadIcon className="size-4" aria-hidden />
              {t('qrSave')}
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStage({ kind: 'choose', order });
            }}
            className={SECONDARY}
          >
            <ArrowLeftIcon className="size-4" aria-hidden />
            {t('otherMethod')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 text-center">
      <h1 className="text-2xl font-bold text-[#092e50]">{t('title')}</h1>
      {summary}
      <p className={MUTED}>{t('choose')}</p>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="grid gap-2.5">
        {order.paymentMethods.map((method) => {
          const Icon = METHOD_ICONS[method];
          return (
            <button
              key={method}
              type="button"
              disabled={busy !== null}
              onClick={() => void pay(order, method)}
              className={method === order.paymentMethods[0] ? PRIMARY : SECONDARY}
            >
              <Icon className="size-5" aria-hidden />
              {busy === method ? t('starting') : t(`methods.${method}`)}
            </button>
          );
        })}
      </div>
      <p className={`text-xs ${MUTED}`}>{t('secure')}</p>
    </div>
  );
}
