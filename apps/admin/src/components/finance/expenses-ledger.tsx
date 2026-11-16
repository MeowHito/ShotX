'use client';

import {
  ADMIN_ROUTES,
  addBangkokDays,
  type AdminExpense,
  bangkokDateSchema,
  type CreateExpenseBody,
  EXPENSE_CATEGORIES,
  EXPENSE_MAX_SATANG,
  EXPENSE_NOTE_MAX_LENGTH,
  EXPENSE_SPENT_ON_MAX_AHEAD_DAYS,
  type ExpenseCategory,
} from '@shotx/shared';
import { Alert, Button, Input, Label, Skeleton } from '@shotx/ui';
import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import { useApiClient, useSessionEndedHandler } from '@/components/providers';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { NativeSelect } from '@/components/ui/select';
import { intlLocale } from '@/i18n/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { todayInBangkok } from '@/lib/format';
import { financeKeys, useExpenses } from '@/lib/finance/queries';
import { formatBucket } from '@/lib/finance/range';
import { useFormat } from '@/lib/i18n/use-format';
import { thbToSatang } from '@/lib/money';

/** `YYYY-MM-DD` (Bangkok) in the UI language, e.g. `16 พ.ย. 2569`. */
function useDayFormat(): (day: string) => string {
  const locale = intlLocale(useLocale());
  return (day) => formatBucket(day, locale, 'long');
}

/**
 * The expenses ledger (ADR 0027 §2) for the finance page's range: "เพิ่มรายจ่าย" and the list,
 * newest spent_on first, each deletable. Every write goes through a confirm dialog and an audited
 * /admin/expenses route; afterwards the summary and the list are refetched.
 */
export function ExpensesLedger({
  range,
  today,
}: {
  range: { from: string; to: string };
  today: string;
}) {
  const t = useTranslations('expenses');
  const tc = useTranslations('common');
  const format = useFormat();
  const day = useDayFormat();
  const errorMessage = useErrorMessage();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const sessionEnded = useSessionEndedHandler();
  const list = useExpenses(range);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = items.reduce((sum, e) => sum + e.amountSatang, 0);

  const [deleting, setDeleting] = useState<AdminExpense | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function confirmDelete() {
    if (deleting === null) return;
    setPending(true);
    setError(null);
    try {
      await api.call(ADMIN_ROUTES.deleteExpense, { params: { id: deleting.id } });
      setMessage(t('deleted', { amount: format.satang(deleting.amountSatang) }));
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: financeKeys.all });
    } catch (caught) {
      if (!sessionEnded(caught)) setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="expenses-title"
      className="min-w-0 space-y-4 rounded-2xl border bg-background p-4 shadow-card sm:p-5"
    >
      <div className="space-y-0.5">
        <h2 id="expenses-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>

      <ExpenseForm today={today} onCreated={(text) => setMessage(text)} />
      <div aria-live="polite">{message !== null ? <Alert>{message}</Alert> : null}</div>

      {list.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError && items.length === 0 ? (
        <Alert variant="destructive">
          {t('loadError')}: {errorMessage(list.error)}
        </Alert>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">{t('tableLabel')}</caption>
              <thead className="border-b bg-sidebar text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('columns.spentOn')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('columns.category')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('columns.amount')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('columns.note')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('columns.recordedAt')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">{t('columns.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{day(e.spentOn)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t(`categories.${e.category}`)}</td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap tabular-nums">
                      {format.satang(e.amountSatang)}
                    </td>
                    <td className="px-3 py-2 break-words">{e.note ?? tc('none')}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {format.dateTime(e.createdAt)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('deleteFor', {
                          amount: format.satang(e.amountSatang),
                          date: day(e.spentOn),
                        })}
                        onClick={() => {
                          setMessage(null);
                          setError(null);
                          setDeleting(e);
                        }}
                      >
                        <Trash2Icon aria-hidden />
                        <span className="hidden sm:inline">{t('delete')}</span>
                      </Button>
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

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setError(null);
          }
        }}
        title={t('deleteTitle', { amount: format.satang(deleting?.amountSatang ?? 0) })}
        description={t('deleteDescription', {
          category: deleting !== null ? t(`categories.${deleting.category}`) : '',
          date: deleting !== null ? day(deleting.spentOn) : '',
        })}
        confirmLabel={t('deleteConfirm')}
        destructive
        pending={pending}
        error={error}
        onConfirm={() => void confirmDelete()}
      >
        {deleting?.note != null ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm break-words">{deleting.note}</p>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

interface FieldErrors {
  amount?: string;
  date?: string;
  category?: string;
  note?: string;
}

/**
 * "เพิ่มรายจ่าย": date, amount typed in baht (sent as integer satang, thbToSatang), a category
 * and an optional note; reviewed in a confirm dialog before POST /admin/expenses.
 */
export function ExpenseForm({
  today = todayInBangkok(),
  onCreated,
}: {
  /** `YYYY-MM-DD` in Asia/Bangkok (tests pass a fixed day). */
  today?: string;
  onCreated?: (message: string) => void;
}) {
  const t = useTranslations('expenses');
  const api = useApiClient();
  const queryClient = useQueryClient();
  const sessionEnded = useSessionEndedHandler();
  const errorMessage = useErrorMessage();
  const format = useFormat();
  const day = useDayFormat();
  const id = useId();
  const latest = addBangkokDays(today, EXPENSE_SPENT_ON_MAX_AHEAD_DAYS);

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [category, setCategory] = useState<ExpenseCategory | ''>('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pendingBody, setPendingBody] = useState<CreateExpenseBody | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Typed but not recorded: the browser asks before the page goes away.
  const dirty = amount.trim() !== '' || note.trim() !== '';
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function review(event: FormEvent) {
    event.preventDefault();
    const errors: FieldErrors = {};
    const money = thbToSatang(amount, EXPENSE_MAX_SATANG);
    if (!money.ok) {
      errors.amount =
        money.reason === 'invalid'
          ? t('invalidAmount')
          : money.reason === 'not_positive'
            ? t('amountNotPositive')
            : t('amountTooLarge', { max: format.satang(EXPENSE_MAX_SATANG) });
    }
    if (!bangkokDateSchema.safeParse(date).success) errors.date = t('invalidDate');
    else if (date > latest) errors.date = t('futureDate');
    if (category === '') errors.category = t('categoryRequired');
    const trimmed = note.trim();
    if (trimmed.length > EXPENSE_NOTE_MAX_LENGTH) {
      errors.note = t('noteTooLong', { max: EXPENSE_NOTE_MAX_LENGTH });
    }
    setFieldErrors(errors);
    if (!money.ok || category === '' || Object.keys(errors).length > 0) return;
    setError(null);
    setPendingBody({
      spentOn: date,
      amountSatang: money.satang,
      category,
      ...(trimmed !== '' ? { note: trimmed } : {}),
    });
  }

  async function confirm() {
    if (pendingBody === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const expense = await api.call(ADMIN_ROUTES.createExpense, { body: pendingBody });
      setPendingBody(null);
      setAmount('');
      setNote('');
      setCategory('');
      onCreated?.(t('created', { amount: format.satang(expense.amountSatang) }));
      void queryClient.invalidateQueries({ queryKey: financeKeys.all });
    } catch (caught) {
      if (!sessionEnded(caught)) setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const describedBy = (field: keyof FieldErrors, hint?: string) =>
    [fieldErrors[field] ? `${id}-${field}-error` : null, hint ?? null].filter(Boolean).join(' ') ||
    undefined;
  const fieldError = (field: keyof FieldErrors) =>
    fieldErrors[field] ? (
      <p id={`${id}-${field}-error`} className="text-sm text-destructive">
        {fieldErrors[field]}
      </p>
    ) : null;

  return (
    <>
      <form
        className="grid gap-3 rounded-xl border bg-sidebar p-3 sm:grid-cols-2 lg:grid-cols-[10rem_10rem_12rem_1fr_auto] lg:items-start"
        onSubmit={review}
        noValidate
        aria-label={t('add')}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-date`}>{t('spentOn')}</Label>
          <Input
            id={`${id}-date`}
            type="date"
            max={latest}
            value={date}
            aria-invalid={fieldErrors.date ? true : undefined}
            aria-describedby={describedBy('date')}
            onChange={(e) => setDate(e.target.value)}
          />
          {fieldError('date')}
        </div>
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
          {fieldError('amount')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-category`}>{t('category')}</Label>
          <NativeSelect
            id={`${id}-category`}
            value={category}
            aria-invalid={fieldErrors.category ? true : undefined}
            aria-describedby={describedBy('category')}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory | '')}
          >
            <option value="">{t('chooseCategory')}</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </NativeSelect>
          {fieldError('category')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-note`}>{t('note')}</Label>
          <Input
            id={`${id}-note`}
            maxLength={EXPENSE_NOTE_MAX_LENGTH}
            autoComplete="off"
            value={note}
            aria-invalid={fieldErrors.note ? true : undefined}
            aria-describedby={describedBy('note', `${id}-note-hint`)}
            onChange={(e) => setNote(e.target.value)}
          />
          <p id={`${id}-note-hint`} className="text-xs text-muted-foreground">
            {t('noteHint', { max: EXPENSE_NOTE_MAX_LENGTH })}
          </p>
          {fieldError('note')}
        </div>
        <Button type="submit" className="lg:mt-[1.6rem]">
          <PlusIcon aria-hidden />
          {t('submit')}
        </Button>
      </form>

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
          category: pendingBody !== null ? t(`categories.${pendingBody.category}`) : '',
          date: pendingBody !== null ? day(pendingBody.spentOn) : '',
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
