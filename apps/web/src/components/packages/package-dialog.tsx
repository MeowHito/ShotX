'use client';

import {
  accountEmailSchema,
  accountNameSchema,
  type CaptchaAction,
  type CaptchaClientConfig,
  type CheckPackageCouponResponse,
  couponCodeSchema,
  ErrorCode,
  PACKAGES_SECTION_PATH,
  type PackagesClientConfig,
  type PublicPackage,
  rateLimitedDetailsSchema,
} from '@shotx/shared';
import {
  Alert,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@shotx/ui';
import { MailCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { ApiError, isApiError } from '@/lib/api/errors';
import type { TurnstileLoader } from '@/lib/captcha/turnstile';
import { changePasswordPageHref } from '@/lib/auth/password-client';
import { navigateTo } from '@/lib/browser/navigate';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFormatSatang } from '@/lib/i18n/use-format';
import { checkPackageCoupon, createPackageOrder, requestFreeSignup } from '@/lib/packages/client';
import { CaptchaChallenge, type CaptchaFailure } from '../share/scan/captcha-challenge';
import { vatPercent } from './vat';

/**
 * What the dialog can do for a package (ADR 0026):
 * - `free`: name + email, then "we sent a confirmation link";
 * - `paid`: price, VAT and total, then the gateway's page;
 * - `soon`: a paid package while online payment is off (PACKAGE_GATEWAY=off): "coming soon,
 *   contact the team" and a disabled pay button;
 * - `contact`: sales are off (PACKAGE_SALES=off): "contact the team" for every package.
 */
export type PackageDialogMode = 'free' | 'paid' | 'soon' | 'contact';

export function packageDialogMode(
  pkg: PublicPackage,
  sales: PackagesClientConfig,
): PackageDialogMode {
  if (!sales.salesEnabled) return 'contact';
  if (pkg.free) return 'free';
  return sales.onlinePayment ? 'paid' : 'soon';
}

/** The dialog's one-line description of `pkg`: a plan's name and terms, or an add-on's (ADR 0032). */
function packageSummary(
  pkg: PublicPackage,
  t: ReturnType<typeof useTranslations<'packageDialog'>>,
): string {
  if (pkg.kind === 'days') return `${t('daysSummary')} · ${t('daysTerms', { days: pkg.days })}`;
  if (pkg.kind === 'photos') {
    return `${t('photosSummary')} · ${t('photosTerms', { photos: pkg.photoLimit })}`;
  }
  const name = pkg.free
    ? t('freeSummary', { name: pkg.name })
    : t('paidSummary', { name: pkg.name });
  return `${name} · ${t('terms', { days: pkg.days, photos: pkg.photoLimit })}`;
}

/** Codes after which the dialog can only say "contact the team" (sales or email switched off). */
const CONTACT_CODES: readonly ErrorCode[] = [ErrorCode.NOT_FOUND, ErrorCode.FEATURE_DISABLED];

// The mockup's dialog look on top of the shared primitives.
const BUTTON =
  'inline-flex h-11 cursor-pointer items-center justify-center rounded-[9px] border px-[18px] text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329] disabled:cursor-not-allowed disabled:opacity-55';
const SECONDARY = `${BUTTON} border-[#dce6ee] bg-white text-[#14293b] hover:bg-[#f3f7fb]`;
const PRIMARY = `${BUTTON} border-[#092e50] bg-[#092e50] text-white hover:bg-[#0c3d69]`;
const FIELD = 'h-12 border-[#dce6ee] bg-white text-[#14293b] md:h-11';

/** How the Free sign-up can answer a captcha request (the home page's CAPTCHA_PROVIDER). */
export interface DialogCaptcha {
  config: CaptchaClientConfig;
  /** Loads Turnstile's script; null when CAPTCHA_PROVIDER isn't `turnstile`. */
  loader: TurnstileLoader | null;
}

const NO_CAPTCHA: DialogCaptcha = { config: { provider: 'none' }, loader: null };

/**
 * The dialog of a package card. `pkg` null: closed. Each opening mounts a fresh form (keyed by the
 * package), so its fields and Idempotency-Key start new.
 */
export function PackageDialog({
  pkg,
  sales,
  signedIn,
  captcha = NO_CAPTCHA,
  onClose,
}: {
  pkg: PublicPackage | null;
  sales: PackagesClientConfig;
  signedIn: boolean;
  captcha?: DialogCaptcha;
  onClose: () => void;
}) {
  const t = useTranslations('packageDialog');
  return (
    <Dialog open={pkg !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {pkg !== null ? (
        <DialogContent
          closeLabel={t('close')}
          className="border-0 bg-white p-7 text-[#14293b] shadow-[0_20px_80px_#071e3480] sm:max-w-[460px] sm:rounded-[18px]"
        >
          <PackageDialogBody
            key={pkg.code}
            pkg={pkg}
            mode={packageDialogMode(pkg, sales)}
            signedIn={signedIn}
            captcha={captcha}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * A RATE_LIMITED whose challenge this dialog can't show, described as "wait" (the API may offer
 * one that web isn't set up for), as the scan flow does.
 */
function waitOnly(err: unknown): unknown {
  if (!isApiError(err, ErrorCode.RATE_LIMITED)) return err;
  const details = rateLimitedDetailsSchema.safeParse(err.details);
  if (!details.success) return err;
  return new ApiError(err.status, err.code, err.message, { ...details.data, captcha: null });
}

function PackageDialogBody({
  pkg,
  mode: initialMode,
  signedIn: initiallySignedIn,
  captcha,
}: {
  pkg: PublicPackage;
  mode: PackageDialogMode;
  signedIn: boolean;
  captcha: DialogCaptcha;
}) {
  const t = useTranslations('packageDialog');
  const tc = useTranslations('capture');
  const te = useTranslations('errors');
  const describe = useErrorMessage();
  const formatSatang = useFormatSatang();
  const ids = {
    name: useId(),
    email: useId(),
    error: useId(),
    coupon: useId(),
    couponStatus: useId(),
  };
  /**
   * The Idempotency-Key of the order being asked for: the same while the request is the same (a
   * retried click after a lost answer is the same order), a new one once the package, name or
   * email changes (the API would answer IDEMPOTENCY_KEY_REUSED for another request).
   */
  const orderKey = useRef<{ request: string; key: string } | null>(null);
  /** The name and email of the Free sign-up waiting for a captcha token. */
  const pendingSignup = useRef<{ name: string; email: string } | null>(null);
  /** A Turnstile challenge the API asked for; `attempt` remounts the widget for a fresh token. */
  const [challenge, setChallenge] = useState<{
    action: CaptchaAction;
    attempt: number;
    failed: boolean;
  } | null>(null);
  const [mode, setMode] = useState(initialMode);
  const [signedIn, setSignedIn] = useState(initiallySignedIn);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<{ text: string; field: 'name' | 'email' | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // ADR 0030: the coupon typed, the one the API priced, and what went wrong with it.
  const [couponText, setCouponText] = useState('');
  const [coupon, setCoupon] = useState<CheckPackageCouponResponse | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const price = coupon?.price ?? pkg.price;

  const askIdentity = mode === 'free' || (mode === 'paid' && !signedIn);
  const rate = vatPercent(pkg.price.vatRateBasisPoints);

  /** The name and email, checked like the API does; null (with the error shown) when invalid. */
  function identity(): { name: string; email: string } | null {
    const n = accountNameSchema.safeParse(name);
    if (!n.success) {
      setError({ text: t('nameMissing'), field: 'name' });
      return null;
    }
    const e = accountEmailSchema.safeParse(email);
    if (!e.success) {
      setError({ text: t('emailInvalid'), field: 'email' });
      return null;
    }
    return { name: n.data, email: e.data };
  }

  /** ADR 0030: prices the typed coupon (the API checks it; nothing is held yet). */
  async function applyCoupon(): Promise<void> {
    const code = couponCodeSchema.safeParse(couponText);
    if (!code.success) {
      setCoupon(null);
      setCouponError(t('couponInvalid'));
      return;
    }
    setCouponBusy(true);
    setCouponError(null);
    try {
      setCoupon(await checkPackageCoupon({ packageCode: pkg.code, couponCode: code.data }));
    } catch (err) {
      setCoupon(null);
      setCouponError(describe(err));
    } finally {
      setCouponBusy(false);
    }
  }

  function fail(err: unknown) {
    setBusy(false);
    if (isApiError(err, ErrorCode.COUPON_INVALID) || isApiError(err, ErrorCode.COUPON_USED_UP)) {
      setCoupon(null);
      setCouponError(describe(err));
      return;
    }
    if (isApiError(err, ErrorCode.PAYMENT_UNAVAILABLE)) {
      setError(null);
      setMode('soon');
      return;
    }
    if (CONTACT_CODES.some((code) => isApiError(err, code))) {
      setError(null);
      setMode('contact');
      return;
    }
    if (isApiError(err, ErrorCode.PASSWORD_CHANGE_REQUIRED)) {
      // A temporary password: change it first, then come back to the packages.
      navigateTo(changePasswordPageHref(PACKAGES_SECTION_PATH));
      return;
    }
    if (signedIn && isApiError(err, ErrorCode.UNAUTHENTICATED)) {
      // The session ended (its cookies are cleared): ask for name and email instead.
      setSignedIn(false);
    }
    setError({ text: describe(err), field: null });
  }

  function keyFor(request: string): string {
    if (orderKey.current?.request !== request) {
      orderKey.current = { request, key: crypto.randomUUID() };
    }
    return orderKey.current.key;
  }

  /**
   * The Turnstile action to show for this answer, or null when it isn't a challenge: with
   * CAPTCHA_PROVIDER=turnstile, POST /signup/free answers RATE_LIMITED with `captcha` (action
   * `signup_free`) until a token is sent and accepted, as face search does.
   */
  function challengeFor(err: unknown): CaptchaAction | null {
    if (captcha.config.provider !== 'turnstile' || captcha.loader === null) return null;
    if (!isApiError(err, ErrorCode.RATE_LIMITED)) return null;
    const details = rateLimitedDetailsSchema.safeParse(err.details);
    const offered = details.success ? details.data.captcha : null;
    if (offered === null || offered.rejected === 'unavailable') return null;
    return offered.action;
  }

  /** Free sign-up step 1, with a captcha token once the API asked for one. */
  async function sendFree(who: { name: string; email: string }, captchaToken?: string) {
    setBusy(true);
    try {
      await requestFreeSignup({ ...who, ...(captchaToken !== undefined ? { captchaToken } : {}) });
      pendingSignup.current = null;
      setChallenge(null);
      setBusy(false);
      setSentTo(who.email);
    } catch (err) {
      const action = challengeFor(err);
      if (action !== null) {
        // Solve the challenge, then the same request goes again with its token.
        setBusy(false);
        pendingSignup.current = who;
        setChallenge((prev) => ({ action, attempt: (prev?.attempt ?? 0) + 1, failed: false }));
        // A refused token says why (expired, invalid); the first ask says what to do.
        const rejected = captchaToken !== undefined ? describe(err) : t('captchaRequired');
        setError({ text: rejected, field: null });
        return;
      }
      pendingSignup.current = null;
      setChallenge(null);
      fail(waitOnly(err));
    }
  }

  function onCaptchaFailure(failure: CaptchaFailure) {
    if (failure === 'expired') {
      // The challenge timed out before a token: a fresh widget.
      setError({ text: te('details.captchaExpired'), field: null });
      setChallenge((prev) => (prev === null ? null : { ...prev, attempt: prev.attempt + 1 }));
    } else {
      setError({ text: te('client.captchaUnavailable'), field: null });
      setChallenge((prev) => (prev === null ? null : { ...prev, failed: true }));
    }
  }

  /** A paid order; a new key and one more try when the API says the key was used for another. */
  async function sendOrder(who: { name: string; email: string } | null) {
    const couponCode = coupon?.couponCode ?? null;
    const request = JSON.stringify([pkg.code, who?.name ?? null, who?.email ?? null, couponCode]);
    const body = {
      packageCode: pkg.code,
      ...(who !== null ? who : {}),
      ...(couponCode !== null ? { couponCode } : {}),
    };
    setBusy(true);
    try {
      let order;
      try {
        order = await createPackageOrder(body, keyFor(request));
      } catch (err) {
        if (!isApiError(err, ErrorCode.IDEMPOTENCY_KEY_REUSED)) throw err;
        orderKey.current = null;
        order = await createPackageOrder(body, keyFor(request));
      }
      // Stay busy: the gateway's page is loading.
      navigateTo(order.redirectUrl);
    } catch (err) {
      fail(err);
    }
  }

  /** A field changed: a pending challenge was for the old name or email, so it is dropped. */
  function edited() {
    if (challenge === null) return;
    pendingSignup.current = null;
    setChallenge(null);
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || challenge !== null) return;
    const who = askIdentity ? identity() : null;
    if (askIdentity && who === null) return;
    setError(null);
    if (mode === 'free') {
      if (who !== null) await sendFree(who);
      return;
    }
    // A code typed but not applied: price it first, so the buyer sees the total before paying.
    if (couponText.trim() !== '' && coupon === null) {
      await applyCoupon();
      return;
    }
    await sendOrder(who);
  }

  if (sentTo !== null) {
    return (
      <div className="grid gap-3" role="status">
        <MailCheckIcon className="size-10 text-[#0875e9]" aria-hidden />
        <DialogTitle className="text-xl font-bold text-[#092e50]">{t('freeSentTitle')}</DialogTitle>
        <DialogDescription className="text-[#667888]">
          {t('freeSentBody', { email: sentTo })}
        </DialogDescription>
        <div className="mt-2 flex justify-end">
          <DialogClose className={SECONDARY}>{t('close')}</DialogClose>
        </div>
      </div>
    );
  }

  const invalid = (field: 'name' | 'email') => (error?.field === field ? true : undefined);
  const describedBy = (field: 'name' | 'email') => (error?.field === field ? ids.error : undefined);
  let notice: ReactNode = null;
  if (mode === 'soon') notice = t('paymentSoon');
  if (mode === 'contact') notice = t('contactTeam');

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-xl font-bold text-[#092e50]">{t('title')}</DialogTitle>
        <DialogDescription className="text-[#667888]">{packageSummary(pkg, t)}</DialogDescription>
      </DialogHeader>

      {pkg.free ? null : (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 rounded-xl bg-[#f3f7fb] px-4 py-3 text-sm">
          <dt className="text-[#667888]">{t('price')}</dt>
          <dd className="text-right tabular-nums">{formatSatang(pkg.price.priceSatang)}</dd>
          {coupon !== null ? (
            <>
              <dt className="text-[#0f7a43]">{t('discount', { percent: coupon.percentOff })}</dt>
              <dd className="text-right text-[#0f7a43] tabular-nums">
                −{formatSatang(pkg.price.priceSatang - coupon.price.priceSatang)}
              </dd>
            </>
          ) : null}
          <dt className="text-[#667888]">{t('vat', { rate })}</dt>
          <dd className="text-right tabular-nums">{formatSatang(price.vatSatang)}</dd>
          <dt className="border-t border-[#dce6ee] pt-1.5 font-bold text-[#092e50]">
            {t('total')}
          </dt>
          <dd className="border-t border-[#dce6ee] pt-1.5 text-right text-base font-extrabold text-[#092e50] tabular-nums">
            {coupon !== null ? (
              <s className="mr-2 text-sm font-normal text-[#667888]">
                {formatSatang(pkg.price.totalSatang)}
              </s>
            ) : null}
            {formatSatang(price.totalSatang)}
          </dd>
        </dl>
      )}

      {notice !== null ? (
        <p className="rounded-xl border border-[#f1d28a] bg-[#fff9e9] px-4 py-3 text-sm text-[#6e551e]">
          {notice}
        </p>
      ) : null}

      {askIdentity && notice === null ? (
        <>
          <p className="text-sm text-[#667888]">
            {mode === 'free' ? t('freeIntro') : t('paidIntro')}
          </p>
          <div className="grid gap-2">
            <Label htmlFor={ids.name} className="text-[#14293b]">
              {t('name')}
            </Label>
            <Input
              id={ids.name}
              name="name"
              autoComplete="name"
              maxLength={200}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                edited();
              }}
              aria-invalid={invalid('name')}
              aria-describedby={describedBy('name')}
              className={FIELD}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.email} className="text-[#14293b]">
              {t('email')}
            </Label>
            <Input
              id={ids.email}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                edited();
              }}
              aria-invalid={invalid('email')}
              aria-describedby={describedBy('email')}
              className={FIELD}
            />
          </div>
        </>
      ) : null}

      {mode === 'paid' && signedIn ? (
        <p className="text-sm text-[#667888]">{t('paidSignedIn')}</p>
      ) : null}

      {mode === 'paid' && !pkg.free ? (
        <div className="grid gap-2">
          <Label htmlFor={ids.coupon} className="text-[#14293b]">
            {t('coupon')}
          </Label>
          <div className="flex gap-2">
            <Input
              id={ids.coupon}
              name="coupon"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={32}
              placeholder={t('couponPlaceholder')}
              value={couponText}
              onChange={(e) => {
                setCouponText(e.target.value);
                setCoupon(null);
                setCouponError(null);
              }}
              aria-invalid={couponError !== null ? true : undefined}
              aria-describedby={ids.couponStatus}
              className={`${FIELD} min-w-0 flex-1 uppercase placeholder:normal-case`}
            />
            {coupon !== null ? (
              <button
                type="button"
                className={`${SECONDARY} shrink-0`}
                onClick={() => {
                  setCoupon(null);
                  setCouponText('');
                }}
              >
                {t('couponRemove')}
              </button>
            ) : (
              <button
                type="button"
                className={`${SECONDARY} shrink-0`}
                disabled={couponBusy || couponText.trim() === ''}
                onClick={() => void applyCoupon()}
              >
                {couponBusy ? t('couponChecking') : t('couponApply')}
              </button>
            )}
          </div>
          <div id={ids.couponStatus} aria-live="polite">
            {couponError !== null ? (
              <p className="text-sm text-[#b42318]">{couponError}</p>
            ) : coupon !== null ? (
              <p className="text-sm text-[#0f7a43]">
                {t('couponApplied', { code: coupon.couponCode, percent: coupon.percentOff })}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <Alert id={ids.error} variant={challenge !== null ? 'warning' : 'destructive'}>
          {error.text}
        </Alert>
      ) : null}

      {challenge !== null && captcha.config.provider === 'turnstile' && captcha.loader !== null ? (
        busy ? (
          <p role="status" className="text-sm text-[#667888]">
            {tc('captchaVerifying')}
          </p>
        ) : challenge.failed ? (
          <button
            type="button"
            className={SECONDARY}
            onClick={() => {
              setError(null);
              setChallenge({ ...challenge, attempt: challenge.attempt + 1, failed: false });
            }}
          >
            {tc('captchaRetry')}
          </button>
        ) : (
          <CaptchaChallenge
            key={challenge.attempt}
            loader={captcha.loader}
            siteKey={captcha.config.siteKey}
            action={challenge.action}
            onToken={(token) => {
              const who = pendingSignup.current;
              if (who !== null) void sendFree(who, token);
            }}
            onFailure={onCaptchaFailure}
          />
        )
      ) : null}

      <div className="mt-1 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
        <DialogClose type="button" className={SECONDARY}>
          {t('close')}
        </DialogClose>
        {mode === 'free' ? (
          <button type="submit" className={PRIMARY} disabled={busy || challenge !== null}>
            {busy ? t('sending') : t('freeSubmit')}
          </button>
        ) : pkg.free ? null : (
          <button
            type="submit"
            className={PRIMARY}
            disabled={busy || couponBusy || mode !== 'paid'}
          >
            {busy ? t('paying') : price.totalSatang === 0 ? t('getFree') : t('pay')}
          </button>
        )}
      </div>
    </form>
  );
}
