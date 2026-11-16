'use client';

import { PACKAGE_CHECKOUT_RETURN_PATH } from '@shotx/shared';
import { Alert } from '@shotx/ui';
import { FlaskConicalIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { navigateTo } from '@/lib/browser/navigate';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { sendFakeResult } from '@/lib/packages/client';

const BUTTON =
  'inline-flex h-12 cursor-pointer items-center justify-center rounded-[10px] px-5 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329] disabled:cursor-not-allowed disabled:opacity-55';

/**
 * The test gateway's "hosted page" (ADR 0026 section 5, PACKAGE_GATEWAY=fake; development and
 * tests only): "paid" or "failed" for the order in this browser's cookie, then the return page,
 * as a real gateway would send the buyer back. Without the fake gateway the API answers
 * NOT_FOUND, shown as is.
 */
export function FakeCheckout({
  orderId,
  fetch: fetchImpl,
}: {
  orderId: string;
  fetch?: typeof fetch;
}) {
  const t = useTranslations('checkout.fake');
  const describe = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(result: 'paid' | 'failed') {
    setBusy(true);
    setError(null);
    try {
      await sendFakeResult({ orderId, result }, fetchImpl);
      // Stay busy: the return page is loading.
      navigateTo(PACKAGE_CHECKOUT_RETURN_PATH);
    } catch (err) {
      setBusy(false);
      setError(describe(err));
    }
  }

  return (
    <div className="grid gap-4 text-center">
      <FlaskConicalIcon className="mx-auto size-10 text-[#0875e9]" aria-hidden />
      <h1 className="text-2xl font-bold text-[#092e50]">{t('title')}</h1>
      <p className="text-[#667888]">{t('body')}</p>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose('paid')}
          className={`${BUTTON} bg-[#092e50] text-white hover:bg-[#0c3d69]`}
        >
          {busy ? t('sending') : t('paid')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose('failed')}
          className={`${BUTTON} border border-[#bfd0df] bg-white text-[#092e50] hover:bg-[#f3f7fb]`}
        >
          {t('failed')}
        </button>
      </div>
    </div>
  );
}
