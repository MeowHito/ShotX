'use client';

import {
  ADMIN_ROUTES,
  type AdminUser,
  CASH_PAYMENT_MAX_SATANG,
  CASH_PAYMENT_NOTE_MAX_LENGTH,
  type CreateCashPaymentBody,
  IDEMPOTENCY_KEY_HEADER,
} from '@shotx/shared';
import { Alert, Button, Input, Label, Skeleton } from '@shotx/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApiClient, useSessionEndedHandler } from '@/components/providers';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ApiError } from '@/lib/api/errors';
import { IdempotencyKeys } from '@/lib/cash/idempotency';
import { cashKeys, useCashPayments } from '@/lib/cash/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { bangkokDateToIso, todayInBangkok } from '@/lib/format';
import { useFormat } from '@/lib/i18n/use-format';
import { thbToSatang } from '@/lib/money';

/**
 * A photographer's cash payments (ADR 0010, optional ledger): the list, newest first, and the
 * "บันทึกรับเงินสด" form. Amounts are typed in baht and sent as integer satang; each payment is
 * confirmed in a dialog and posted with an Idempotency-Key, so a retried request can't record it
 * twice. Bookkeeping only: recording a payment doesn't enable or disable the account.
 */
export function CashPayments({ photographer }: { photographer: AdminUser }) {
  const t = useTranslations('cash');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorMessage = useErrorMessage();
  const list = useCashPayments(photographer.id);
  const payments = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = payments.reduce((sum, p) => sum + p.amountSatang, 0);

  return (
    <section className="space-y-4" aria-labelledby="cash-title">
      <div className="space-y-1">
        <h2 id="cash-title" className="text-xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <CashPaymentForm photographer={photographer} />

      {list.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError && payments.length === 0 ? (
        <Alert variant="destructive">
          {t('loadError')}: {errorMessage(list.error)}
        </Alert>
      ) : payments.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-background shadow-card">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">{t('tableLabel')}</caption>
              <thead className="border-b bg-sidebar text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.paidAt')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    {t('columns.amount')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.note')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.recordedAt')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 whitespace-nowrap">{format.date(p.paidAt)}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {format.satang(p.amountSatang)}
                    </td>
                    <td className="px-4 py-3 break-words">{p.note ?? tc('none')}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {format.dateTime(p.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-right text-sm text-muted-foreground">
            {t('total', { amount: format.satang(total) })}
          </p>
          {list.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {t('loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

interface FieldErrors {
  amount?: string;
  date?: string;
  note?: string;
}

export function CashPaymentForm({
  photographer,
  today = todayInBangkok(),
}: {
  photographer: AdminUser;
  /** `YYYY-MM-DD` in Asia/Bangkok (tests pass a fixed day). */
  today?: string;
}) {
  const t = useTranslations('cash');
  const api = useApiClient();
  const queryClient = useQueryClient();
  const sessionEnded = useSessionEndedHandler();
  const errorMessage = useErrorMessage();
  const format = useFormat();
  const id = useId();
  const keys = useRef(new IdempotencyKeys());

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pendingBody, setPendingBody] = useState<CreateCashPaymentBody | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // An amount or note typed but not recorded: the browser asks before the page goes away (the
  // language switcher reloads the page; so does closing or refreshing the tab).
  const dirty = amount.trim() !== '' || note.trim() !== '';
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function review(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const errors: FieldErrors = {};
    const money = thbToSatang(amount);
    if (!money.ok) {
      errors.amount =
        money.reason === 'invalid'
          ? t('invalidAmount')
          : money.reason === 'not_positive'
            ? t('amountNotPositive')
            : t('amountTooLarge', { max: format.satang(CASH_PAYMENT_MAX_SATANG) });
    }
    const paidAt = bangkokDateToIso(date);
    if (paidAt === null) errors.date = t('invalidDate');
    else if (date > today) errors.date = t('futureDate');
    const trimmed = note.trim();
    if (trimmed.length > CASH_PAYMENT_NOTE_MAX_LENGTH) {
      errors.note = t('noteTooLong', { max: CASH_PAYMENT_NOTE_MAX_LENGTH });
    }
    setFieldErrors(errors);
    if (!money.ok || paidAt === null || Object.keys(errors).length > 0) return;
    setError(null);
    setPendingBody({
      photographerId: photographer.id,
      amountSatang: money.satang,
      paidAt,
      ...(trimmed !== '' ? { note: trimmed } : {}),
    });
  }

  async function confirm() {
    if (pendingBody === null) return;
    setSubmitting(true);
    setError(null);
    const key = keys.current.keyFor(JSON.stringify(pendingBody));
    try {
      const payment = await api.call(ADMIN_ROUTES.createCashPayment, {
        headers: { [IDEMPOTENCY_KEY_HEADER]: key },
        body: pendingBody,
      });
      keys.current.settle();
      setPendingBody(null);
      setAmount('');
      setNote('');
      setMessage(t('recorded', { amount: format.satang(payment.amountSatang) }));
      void queryClient.invalidateQueries({ queryKey: cashKeys.byPhotographer(photographer.id) });
    } catch (caught) {
      // A definite refusal can't have recorded anything: the next try gets a new key. Without an
      // answer (network, 5xx) the same request keeps its key, so a retry is never a duplicate.
      if (caught instanceof ApiError && caught.status < 500) keys.current.settle();
      if (!sessionEnded(caught)) setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const describedBy = (field: keyof FieldErrors, hint?: string) =>
    [fieldErrors[field] ? `${id}-${field}-error` : null, hint ?? null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <>
      <form
        className="grid gap-4 rounded-xl border bg-sidebar p-4 sm:grid-cols-[1fr_1fr] lg:grid-cols-[12rem_12rem_1fr_auto] lg:items-start"
        onSubmit={review}
        noValidate
        aria-label={t('record')}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-amount`}>{t('amount')}</Label>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            placeholder={t('amountPlaceholder')}
            value={amount}
            aria-invalid={fieldErrors.amount ? true : undefined}
            aria-describedby={describedBy('amount')}
            onChange={(e) => setAmount(e.target.value)}
          />
          {fieldErrors.amount ? (
            <p id={`${id}-amount-error`} className="text-sm text-destructive">
              {fieldErrors.amount}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-date`}>{t('paidAt')}</Label>
          <Input
            id={`${id}-date`}
            type="date"
            max={today}
            value={date}
            aria-invalid={fieldErrors.date ? true : undefined}
            aria-describedby={describedBy('date')}
            onChange={(e) => setDate(e.target.value)}
          />
          {fieldErrors.date ? (
            <p id={`${id}-date-error`} className="text-sm text-destructive">
              {fieldErrors.date}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor={`${id}-note`}>{t('note')}</Label>
          <textarea
            id={`${id}-note`}
            rows={1}
            maxLength={CASH_PAYMENT_NOTE_MAX_LENGTH}
            className="flex min-h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-base focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none md:text-sm"
            value={note}
            aria-invalid={fieldErrors.note ? true : undefined}
            aria-describedby={describedBy('note', `${id}-note-hint`)}
            onChange={(e) => setNote(e.target.value)}
          />
          <p id={`${id}-note-hint`} className="text-xs text-muted-foreground">
            {t('noteHint', { max: CASH_PAYMENT_NOTE_MAX_LENGTH })}
          </p>
          {fieldErrors.note ? (
            <p id={`${id}-note-error`} className="text-sm text-destructive">
              {fieldErrors.note}
            </p>
          ) : null}
        </div>
        <Button type="submit" className="lg:mt-[1.6rem]">
          {t('submit')}
        </Button>
      </form>
      <div aria-live="polite">{message !== null ? <Alert>{message}</Alert> : null}</div>

      <ConfirmDialog
        open={pendingBody !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingBody(null);
            setError(null);
          }
        }}
        title={t('confirmTitle', { amount: format.satang(pendingBody?.amountSatang ?? 0) })}
        description={t('confirmDescription', {
          name: photographer.name ?? photographer.email ?? '',
          date: pendingBody !== null ? format.date(pendingBody.paidAt) : '',
        })}
        confirmLabel={t('confirm')}
        pending={submitting}
        error={error}
        onConfirm={() => void confirm()}
      >
        {pendingBody?.note !== undefined ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm break-words">{pendingBody.note}</p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
