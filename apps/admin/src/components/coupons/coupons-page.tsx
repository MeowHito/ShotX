'use client';

import {
  ADMIN_ROUTES,
  type AdminCoupon,
  COUPON_MAX_REDEMPTIONS_LIMIT,
  COUPON_NOTE_MAX_LENGTH,
  COUPON_PERCENT_MAX,
  COUPON_PERCENT_MIN,
  couponCodeSchema,
  type CreateCouponBody,
} from '@shotx/shared';
import { Alert, Button, Input, Label, Skeleton } from '@shotx/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, PlusIcon, PowerIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { useApiClient, useSessionEndedHandler } from '@/components/providers';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { todayInBangkok } from '@/lib/format';
import { useFormat } from '@/lib/i18n/use-format';

// ADR 0030: admin coupons. Every write goes through a confirm dialog and an audited
// /admin/coupons route; afterwards the list is refetched.

export const couponKeys = { all: ['admin-coupons'] as const };

/** The end of a Bangkok day (`YYYY-MM-DD`) as an ISO instant: a coupon works through that day. */
export function endOfBangkokDay(day: string): string {
  return new Date(`${day}T23:59:59.999+07:00`).toISOString();
}

type CouponState = 'active' | 'inactive' | 'expired' | 'usedUp';

export function couponState(coupon: AdminCoupon, now: number): CouponState {
  if (!coupon.isActive) return 'inactive';
  if (coupon.expiresAt !== null && new Date(coupon.expiresAt).getTime() <= now) return 'expired';
  if (coupon.paidCount + coupon.holdingCount >= coupon.maxRedemptions) return 'usedUp';
  return 'active';
}

const STATE_STYLE: Record<CouponState, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  inactive: 'bg-muted text-muted-foreground',
  expired: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  usedUp: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
};

function useCoupons() {
  const api = useApiClient();
  return useQuery({
    queryKey: couponKeys.all,
    queryFn: ({ signal }) => api.call(ADMIN_ROUTES.listCoupons, { signal }),
  });
}

export function CouponsPage() {
  const t = useTranslations('coupons');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorMessage = useErrorMessage();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const sessionEnded = useSessionEndedHandler();
  const list = useCoupons();
  const [now] = useState(() => Date.now());
  const [message, setMessage] = useState<string | null>(null);

  /** The pending change: switch on or off, or new uses. */
  const [change, setChange] = useState<
    { kind: 'toggle'; coupon: AdminCoupon } | { kind: 'max'; coupon: AdminCoupon } | null
  >(null);
  const [maxText, setMaxText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maxId = useId();

  async function confirmChange() {
    if (change === null) return;
    const body =
      change.kind === 'toggle'
        ? { isActive: !change.coupon.isActive }
        : { maxRedemptions: Number(maxText) };
    if (
      change.kind === 'max' &&
      (!Number.isInteger(body.maxRedemptions) ||
        (body.maxRedemptions ?? 0) < 1 ||
        (body.maxRedemptions ?? 0) > COUPON_MAX_REDEMPTIONS_LIMIT)
    ) {
      setError(t('maxInvalid', { max: COUPON_MAX_REDEMPTIONS_LIMIT }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const saved = await api.call(ADMIN_ROUTES.updateCoupon, {
        params: { id: change.coupon.id },
        body,
      });
      setMessage(t('updated', { code: saved.code }));
      setChange(null);
      void queryClient.invalidateQueries({ queryKey: couponKeys.all });
    } catch (caught) {
      if (!sessionEnded(caught)) setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  const items = list.data?.items ?? [];
  const toggling = change?.kind === 'toggle' ? change.coupon : null;
  const editing = change?.kind === 'max' ? change.coupon : null;

  return (
    <div className="min-w-0 space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('description')}</p>
      </header>

      <section className="min-w-0 space-y-4 rounded-2xl border bg-background p-4 shadow-card sm:p-5">
        <CouponForm onCreated={(text) => setMessage(text)} />
        <div aria-live="polite">{message !== null ? <Alert>{message}</Alert> : null}</div>

        {list.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : list.isError ? (
          <Alert variant="destructive">
            {t('loadError')}: {errorMessage(list.error)}
          </Alert>
        ) : items.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <caption className="sr-only">{t('tableLabel')}</caption>
              <thead className="border-b bg-sidebar text-xs text-muted-foreground">
                <tr>
                  {(['code', 'percent', 'uses', 'expiresAt', 'status', 'note'] as const).map(
                    (column) => (
                      <th key={column} scope="col" className="px-3 py-2 font-medium">
                        {t(`columns.${column}`)}
                      </th>
                    ),
                  )}
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">{t('columns.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((c) => {
                  const state = couponState(c, now);
                  return (
                    <tr key={c.id}>
                      <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">
                        {c.code}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {t('percentValue', { percent: c.percentOff })}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {t('usesValue', {
                          used: c.paidCount + c.holdingCount,
                          max: c.maxRedemptions,
                        })}
                        {c.holdingCount > 0 ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('holding', { count: c.holdingCount })}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {c.expiresAt === null ? t('noExpiry') : format.dateTime(c.expiresAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[state]}`}
                        >
                          {t(`status.${state}`)}
                        </span>
                      </td>
                      <td className="px-3 py-2 break-words">{c.note ?? tc('none')}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setMessage(null);
                            setError(null);
                            setMaxText(String(c.maxRedemptions));
                            setChange({ kind: 'max', coupon: c });
                          }}
                        >
                          <PencilIcon aria-hidden />
                          {t('editMax')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setMessage(null);
                            setError(null);
                            setChange({ kind: 'toggle', coupon: c });
                          }}
                        >
                          <PowerIcon aria-hidden />
                          {c.isActive ? t('disable') : t('enable')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => {
          if (!open) setChange(null);
        }}
        title={t('toggleTitle', {
          action: toggling?.isActive === true ? t('disable') : t('enable'),
          code: toggling?.code ?? '',
        })}
        description={toggling?.isActive === true ? t('disableDescription') : t('enableDescription')}
        confirmLabel={toggling?.isActive === true ? t('disable') : t('enable')}
        destructive={toggling?.isActive === true}
        pending={pending}
        error={error}
        onConfirm={() => void confirmChange()}
      />

      <ConfirmDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setChange(null);
        }}
        title={t('editMaxTitle', { code: editing?.code ?? '' })}
        description={t('editMaxDescription', {
          used: (editing?.paidCount ?? 0) + (editing?.holdingCount ?? 0),
        })}
        confirmLabel={t('save')}
        pending={pending}
        error={error}
        onConfirm={() => void confirmChange()}
      >
        <div className="space-y-1.5">
          <Label htmlFor={maxId}>{t('maxRedemptions')}</Label>
          <Input
            id={maxId}
            inputMode="numeric"
            autoComplete="off"
            value={maxText}
            onChange={(e) => setMaxText(e.target.value)}
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}

interface FieldErrors {
  code?: string;
  percent?: string;
  max?: string;
  expires?: string;
  note?: string;
}

/** "สร้างคูปอง": code, percent off, uses, an optional last day and note; confirmed first. */
export function CouponForm({
  today = todayInBangkok(),
  onCreated,
}: {
  /** `YYYY-MM-DD` in Asia/Bangkok (tests pass a fixed day). */
  today?: string;
  onCreated?: (message: string) => void;
}) {
  const t = useTranslations('coupons');
  const api = useApiClient();
  const queryClient = useQueryClient();
  const sessionEnded = useSessionEndedHandler();
  const errorMessage = useErrorMessage();
  const format = useFormat();
  const id = useId();

  const [code, setCode] = useState('');
  const [percent, setPercent] = useState('');
  const [max, setMax] = useState('1');
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pendingBody, setPendingBody] = useState<CreateCouponBody | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function review(event: FormEvent) {
    event.preventDefault();
    const errors: FieldErrors = {};
    const parsedCode = couponCodeSchema.safeParse(code);
    if (!parsedCode.success) errors.code = t('codeInvalid');
    const percentOff = Number(percent);
    if (
      percent.trim() === '' ||
      !Number.isInteger(percentOff) ||
      percentOff < COUPON_PERCENT_MIN ||
      percentOff > COUPON_PERCENT_MAX
    ) {
      errors.percent = t('percentInvalid');
    }
    const maxRedemptions = Number(max);
    if (
      max.trim() === '' ||
      !Number.isInteger(maxRedemptions) ||
      maxRedemptions < 1 ||
      maxRedemptions > COUPON_MAX_REDEMPTIONS_LIMIT
    ) {
      errors.max = t('maxInvalid', { max: COUPON_MAX_REDEMPTIONS_LIMIT });
    }
    if (expiresOn !== '' && expiresOn < today) errors.expires = t('expiresInvalid');
    const trimmed = note.trim();
    if (trimmed.length > COUPON_NOTE_MAX_LENGTH) {
      errors.note = t('noteTooLong', { max: COUPON_NOTE_MAX_LENGTH });
    }
    setFieldErrors(errors);
    if (!parsedCode.success || Object.keys(errors).length > 0) return;
    setError(null);
    setPendingBody({
      code: parsedCode.data,
      percentOff,
      maxRedemptions,
      ...(expiresOn !== '' ? { expiresAt: endOfBangkokDay(expiresOn) } : {}),
      ...(trimmed !== '' ? { note: trimmed } : {}),
    });
  }

  async function confirm() {
    if (pendingBody === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const coupon = await api.call(ADMIN_ROUTES.createCoupon, { body: pendingBody });
      setPendingBody(null);
      setCode('');
      setPercent('');
      setMax('1');
      setExpiresOn('');
      setNote('');
      onCreated?.(t('created', { code: coupon.code }));
      void queryClient.invalidateQueries({ queryKey: couponKeys.all });
    } catch (caught) {
      if (!sessionEnded(caught)) setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldError = (field: keyof FieldErrors) =>
    fieldErrors[field] ? (
      <p id={`${id}-${field}-error`} className="text-sm text-destructive">
        {fieldErrors[field]}
      </p>
    ) : null;
  const describedBy = (field: keyof FieldErrors, hint?: string) =>
    [fieldErrors[field] ? `${id}-${field}-error` : null, hint ?? null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <>
      <form
        className="grid gap-3 rounded-xl border bg-sidebar p-3 sm:grid-cols-2 lg:grid-cols-[12rem_7rem_8rem_11rem_1fr_auto] lg:items-start"
        onSubmit={review}
        noValidate
        aria-label={t('add')}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-code`}>{t('code')}</Label>
          <Input
            id={`${id}-code`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={32}
            className="font-mono uppercase"
            value={code}
            aria-invalid={fieldErrors.code ? true : undefined}
            aria-describedby={describedBy('code', `${id}-code-hint`)}
            onChange={(e) => setCode(e.target.value)}
          />
          <p id={`${id}-code-hint`} className="text-xs text-muted-foreground">
            {t('codeHint')}
          </p>
          {fieldError('code')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-percent`}>{t('percent')}</Label>
          <Input
            id={`${id}-percent`}
            type="number"
            inputMode="numeric"
            min={COUPON_PERCENT_MIN}
            max={COUPON_PERCENT_MAX}
            step={1}
            value={percent}
            aria-invalid={fieldErrors.percent ? true : undefined}
            aria-describedby={describedBy('percent')}
            onChange={(e) => setPercent(e.target.value)}
          />
          {fieldError('percent')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-max`}>{t('maxRedemptions')}</Label>
          <Input
            id={`${id}-max`}
            type="number"
            inputMode="numeric"
            min={1}
            max={COUPON_MAX_REDEMPTIONS_LIMIT}
            step={1}
            value={max}
            aria-invalid={fieldErrors.max ? true : undefined}
            aria-describedby={describedBy('max')}
            onChange={(e) => setMax(e.target.value)}
          />
          {fieldError('max')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-expires`}>{t('expiresOn')}</Label>
          <Input
            id={`${id}-expires`}
            type="date"
            min={today}
            value={expiresOn}
            aria-invalid={fieldErrors.expires ? true : undefined}
            aria-describedby={describedBy('expires', `${id}-expires-hint`)}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
          <p id={`${id}-expires-hint`} className="text-xs text-muted-foreground">
            {t('expiresHint')}
          </p>
          {fieldError('expires')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-note`}>{t('note')}</Label>
          <Input
            id={`${id}-note`}
            maxLength={COUPON_NOTE_MAX_LENGTH}
            autoComplete="off"
            value={note}
            aria-invalid={fieldErrors.note ? true : undefined}
            aria-describedby={describedBy('note')}
            onChange={(e) => setNote(e.target.value)}
          />
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
        title={t('confirmTitle', { code: pendingBody?.code ?? '' })}
        description={t('confirmDescription', {
          percent: pendingBody?.percentOff ?? 0,
          max: pendingBody?.maxRedemptions ?? 0,
          expiry:
            pendingBody?.expiresAt !== undefined
              ? format.dateTime(pendingBody.expiresAt)
              : t('noExpiry'),
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
