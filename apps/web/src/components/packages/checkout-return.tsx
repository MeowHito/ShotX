'use client';

import { ErrorCode, PACKAGES_SECTION_PATH, type PackageOrderView } from '@shotx/shared';
import {
  CheckCircle2Icon,
  Loader2Icon,
  MailCheckIcon,
  SearchXIcon,
  XCircleIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { isApiError } from '@/lib/api/errors';
import { useFormatSatang } from '@/lib/i18n/use-format';
import { fetchPackageOrder } from '@/lib/packages/client';

/** Where a buyer with an account goes once the package is added. */
const STUDIO_PATH = '/studio';

export type CheckoutReturnState =
  | { kind: 'checking' }
  | { kind: 'timeout' }
  | { kind: 'notFound' }
  | { kind: 'order'; order: PackageOrderView };

const LINK =
  'inline-flex h-11 items-center justify-center rounded-[10px] px-5 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329]';
const PRIMARY_LINK = `${LINK} bg-[#092e50] text-white hover:bg-[#0c3d69]`;
const SECONDARY_LINK = `${LINK} border border-[#bfd0df] bg-white text-[#092e50] hover:bg-[#f3f7fb]`;

/**
 * `/checkout/return` (ADR 0026 section 4.3): the gateway sends the buyer here. The order is the
 * one in this browser's httpOnly cookie (the page only knows whether there is one); its status is
 * polled through web (GET /checkout/order) every `intervalMs` until it is no longer pending or
 * `timeoutMs` has passed (PACKAGE_ORDER_POLL_INTERVAL_SECONDS / _TIMEOUT_SECONDS).
 */
export function CheckoutReturn({
  hasOrder,
  intervalMs,
  timeoutMs,
  fetch: fetchImpl,
}: {
  hasOrder: boolean;
  intervalMs: number;
  timeoutMs: number;
  fetch?: typeof fetch;
}) {
  const [state, setState] = useState<CheckoutReturnState>(
    hasOrder ? { kind: 'checking' } : { kind: 'notFound' },
  );
  // Bumped by "check again" to start a new round of polling.
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!hasOrder) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const poll = async () => {
      let next: CheckoutReturnState | null = null;
      try {
        const order = await fetchPackageOrder(fetchImpl);
        if (order.status !== 'pending') next = { kind: 'order', order };
      } catch (error) {
        if (isApiError(error, ErrorCode.ORDER_NOT_FOUND)) next = { kind: 'notFound' };
        // Anything else (offline, the API restarting) is asked again on the next round.
      }
      if (stopped) return;
      if (next !== null) {
        setState(next);
        return;
      }
      if (Date.now() - startedAt + intervalMs > timeoutMs) {
        setState({ kind: 'timeout' });
        return;
      }
      timer = setTimeout(() => void poll(), intervalMs);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [hasOrder, intervalMs, timeoutMs, fetchImpl, round]);

  const checkAgain = useCallback(() => {
    setState({ kind: 'checking' });
    setRound((r) => r + 1);
  }, []);

  return <CheckoutReturnView state={state} onCheckAgain={checkAgain} />;
}

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 text-center" aria-live="polite">
      {icon}
      <h1 className="text-2xl font-bold text-[#092e50]">{title}</h1>
      {children}
    </div>
  );
}

export function CheckoutReturnView({
  state,
  onCheckAgain,
}: {
  state: CheckoutReturnState;
  /** "Check again" after the polling gave up (absent: no button). */
  onCheckAgain?: () => void;
}) {
  const t = useTranslations('checkout');
  const format = useFormatter();
  const formatSatang = useFormatSatang();
  const muted = 'text-[#667888]';

  if (state.kind === 'checking' || state.kind === 'timeout') {
    return (
      <Panel
        icon={<Loader2Icon className="size-10 animate-spin text-[#0875e9]" aria-hidden />}
        title={t('title')}
      >
        <p className={muted} role="status">
          {state.kind === 'checking' ? t('pending') : t('timeout')}
        </p>
        {state.kind === 'timeout' && onCheckAgain !== undefined ? (
          <button type="button" onClick={onCheckAgain} className={SECONDARY_LINK}>
            {t('checkAgain')}
          </button>
        ) : null}
      </Panel>
    );
  }

  if (state.kind === 'notFound') {
    return (
      <Panel
        icon={<SearchXIcon className="size-10 text-[#667888]" aria-hidden />}
        title={t('notFoundTitle')}
      >
        <p className={muted}>{t('notFoundBody')}</p>
        <Link href={PACKAGES_SECTION_PATH} className={SECONDARY_LINK}>
          {t('backToPackages')}
        </Link>
      </Panel>
    );
  }

  const { order } = state;
  const details = (
    <ul className="w-full space-y-1 rounded-xl bg-[#f3f7fb] px-4 py-3 text-sm text-[#14293b]">
      <li>{t('package', { name: order.packageName })}</li>
      {order.expiresAt !== null ? (
        <li>
          {t('expiresAt', {
            date: format.dateTime(new Date(order.expiresAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </li>
      ) : null}
      <li>{t('total', { amount: formatSatang(order.totalSatang) })}</li>
    </ul>
  );

  if (order.status === 'paid') {
    return (
      <Panel
        icon={<CheckCircle2Icon className="size-10 text-[#16a34a]" aria-hidden />}
        title={t('paidTitle')}
      >
        {order.accountCreated ? (
          <>
            <p className="flex items-center gap-2 font-semibold text-[#092e50]">
              <MailCheckIcon className="size-5 shrink-0 text-[#0875e9]" aria-hidden />
              {t('accountCreated', { email: order.emailMasked })}
            </p>
            <p className={muted}>{t('accountCreatedHint')}</p>
          </>
        ) : (
          <p className="font-semibold text-[#092e50]">{t('added')}</p>
        )}
        {details}
        {order.accountCreated ? null : (
          <Link href={STUDIO_PATH} className={PRIMARY_LINK}>
            {t('goStudio')}
          </Link>
        )}
      </Panel>
    );
  }

  // failed, amount_mismatch
  const mismatch = order.status === 'amount_mismatch';
  return (
    <Panel
      icon={<XCircleIcon className="size-10 text-[#dc2626]" aria-hidden />}
      title={mismatch ? t('mismatchTitle') : t('failedTitle')}
    >
      <p className={muted}>{mismatch ? t('mismatchBody') : t('failedBody')}</p>
      {details}
      <Link href={PACKAGES_SECTION_PATH} className={PRIMARY_LINK}>
        {t('retry')}
      </Link>
      <p className={`text-sm ${muted}`}>{t('contact')}</p>
    </Panel>
  );
}
