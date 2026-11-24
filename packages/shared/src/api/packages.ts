import { z } from 'zod';
import {
  accountEmailSchema,
  accountNameSchema,
  newPasswordSchema,
} from '../account/password-accounts';
import { opaqueTokenSchema } from '../account/tokens';
import {
  COUPON_PERCENT_MAX,
  COUPON_PERCENT_MIN,
  packageTotalSchema,
  satangSchema,
} from '../billing/money';
import { PACKAGE_CODE_PATTERN, packagesClientConfigSchema } from '../config/packages';
import {
  PACKAGE_KINDS,
  PACKAGE_ORDER_STATUSES,
  PACKAGE_PAYMENT_GATEWAYS,
  PACKAGE_PAYMENT_METHODS,
} from '../domain';
import { idSchema, isoDateTimeSchema } from './common';
import { captchaTokenSchema, IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from './share-page';

// Packages, Free sign-up and package orders (ADR 0026). Money is integer satang; package prices
// are VAT-exclusive and the API sends the VAT and total (packageTotal), so clients never compute
// prices. No `photographer_packages` row means unlimited (admin-created accounts).

/** A `packages.code`, e.g. `free`, `d7`. */
export const packageCodeSchema = z.string().regex(PACKAGE_CODE_PATTERN, {
  error: 'must be a package code',
});

/**
 * ADR 0030: `package_coupons.code` as stored: 3–32 of A–Z, 0–9, `-` and `_`, starting with a
 * letter or digit (the `package_coupons_code_format` CHECK).
 */
export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

/** A coupon code as typed: trimmed and upper-cased first, so codes are case-insensitive. */
export const couponCodeSchema = z
  .string()
  .trim()
  .transform((code) => code.toUpperCase())
  .pipe(z.string().regex(COUPON_CODE_PATTERN, { error: 'must be a coupon code' }));

/** A coupon's percent off (1–100, whole numbers). */
export const couponPercentSchema = z.number().int().min(COUPON_PERCENT_MIN).max(COUPON_PERCENT_MAX);

// --- Web paths, cookie and header names -------------------------------------------------------

/** The page the Free confirmation email links to (PUBLIC_BASE_URL + this + `#token=<token>`). */
export const SIGNUP_CONFIRM_PATH = '/signup/confirm';

/** The gateway's return URL (PUBLIC_BASE_URL + this); it polls GET /package-orders/:id. */
export const PACKAGE_CHECKOUT_RETURN_PATH = '/checkout/return';

/** The fake gateway's "hosted page" in web (`?order=<id>`), dev and tests only. */
export const PACKAGE_FAKE_CHECKOUT_PATH = '/checkout/fake';

/**
 * ADR 0029: Snap's own pay page (`?order=<id>`) for gateways with `paymentMethods` (mPAY): the
 * buyer picks PromptPay QR or card. `createCheckout` answers it as the `redirectUrl`.
 */
export const PACKAGE_PAY_PATH = '/checkout/pay';

/**
 * ADR 0029: where the gateway's card form sends the browser back (GET or POST); web answers 303
 * to PACKAGE_CHECKOUT_RETURN_PATH. The outcome is never read from this request.
 */
export const PACKAGE_GATEWAY_RETURN_PATH = '/checkout/back';

/** Where `/pricing` sends people: the package cards on the home page. */
export const PACKAGES_SECTION_PATH = '/#packages';

/**
 * ADR 0032: the studio page where a photographer with a package renews it or buys more days or
 * photos (GET /me/package/offers); the studio's "ต่ออายุ" links go here.
 */
export const STUDIO_PACKAGE_PATH = '/studio/package';

/**
 * httpOnly cookie the web BFF sets after POST /package-orders: `{orderId}.{accessToken}`
 * (packageOrderCookieValue), max-age PACKAGE_ORDER_COOKIE_MAX_AGE_SECONDS. Never readable by
 * browser JS; the BFF sends the token to the API in ORDER_TOKEN_HEADER.
 */
export const PACKAGE_ORDER_COOKIE = 'snap_order';
export const PACKAGE_ORDER_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Header with an order's access token (lowercase, as Node sees it). The API compares
 * SHA-256(token) with `package_orders.access_token_hash` in constant time.
 */
export const ORDER_TOKEN_HEADER = 'x-order-token';

/** The PACKAGE_ORDER_COOKIE value. */
export function packageOrderCookieValue(orderId: string, accessToken: string): string {
  return `${idSchema.parse(orderId)}.${opaqueTokenSchema.parse(accessToken)}`;
}

/** Parses a PACKAGE_ORDER_COOKIE value; null when it is malformed. */
export function parsePackageOrderCookie(
  value: string | undefined | null,
): { orderId: string; accessToken: string } | null {
  if (value === undefined || value === null) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const orderId = idSchema.safeParse(value.slice(0, dot));
  const accessToken = opaqueTokenSchema.safeParse(value.slice(dot + 1));
  if (!orderId.success || !accessToken.success) return null;
  return { orderId: orderId.data, accessToken: accessToken.data };
}

// --- GET /packages (public) ------------------------------------------------------------------------

/**
 * One package card. ADR 0032: `kind` `plan` has days and photos; a `days` add-on has
 * `photoLimit` 0 and a `photos` add-on `days` 0 (the `packages_kind_terms` CHECK).
 */
export const publicPackageSchema = z
  .object({
    code: packageCodeSchema,
    name: z.string().min(1),
    kind: z.enum(PACKAGE_KINDS),
    days: z.number().int().nonnegative(),
    photoLimit: z.number().int().nonnegative(),
    /** `code === PACKAGES_FEATURED_CODE`. */
    featured: z.boolean(),
    /** The Free package (FREE_PACKAGE_CODE): signed up for, never ordered. */
    free: z.boolean(),
    /** packageTotal(price_satang, VAT_RATE_BASIS_POINTS): all zero for Free. */
    price: packageTotalSchema,
  })
  .refine(
    (p) =>
      p.kind === 'plan'
        ? p.days > 0 && p.photoLimit > 0
        : p.kind === 'days'
          ? p.days > 0 && p.photoLimit === 0
          : p.days === 0 && p.photoLimit > 0,
    { error: 'days and photoLimit must fit the kind' },
  );
export type PublicPackage = z.output<typeof publicPackageSchema>;

/**
 * Active `plan` packages by `sort_order`, Free included (the home page shows five cards; ADR 0032
 * add-ons are never listed here, only in GET /me/package/offers). Public, no
 * token; answers whatever PACKAGE_SALES is (the home page always shows prices). Cacheable for a
 * minute.
 */
export const packagesResponseSchema = z.object({
  packages: z.array(publicPackageSchema),
  currency: z.literal('THB'),
  vatRateBasisPoints: z.number().int().min(0).max(10_000),
  /** Sales switches (packagesClientConfigOf): sign-up / order dialogs read these. */
  sales: packagesClientConfigSchema,
});
export type PackagesResponse = z.output<typeof packagesResponseSchema>;

/**
 * GET /me/package/offers (ADR 0032, photographer): what the signed-in account can buy from the
 * studio, in the packagesResponseSchema shape: active, priced plans (no Free, "ต่ออายุ") and the
 * add-ons (`days`, `photos`), by `sort_order`. Empty for an unlimited account (no package row).
 */
export const packageOffersResponseSchema = packagesResponseSchema;
export type PackageOffersResponse = z.output<typeof packageOffersResponseSchema>;

// --- POST /signup/free, POST /signup/free/confirm (bff) ---------------------------------------------

/**
 * Free sign-up step 1. Always 204 for a well-formed body, whether or not the email has an
 * account (no enumeration). No account: a confirmation link (SIGNUP_CONFIRM_PATH + `#token=`,
 * SIGNUP_LINK_TTL_SECONDS); an account: an email saying so, with sign-in and "ลืมรหัสผ่าน" links.
 * Emails go out after the answer. Rate-limited per IP (SIGNUP_RATE_PER_IP), per email
 * (SIGNUP_EMAILS_PER_HOUR, silently) and in total (SIGNUP_EMAILS_PER_DAY, silently). The emails
 * never repeat the typed name (it is unverified). With CAPTCHA_PROVIDER=turnstile a captcha token
 * is required (`captchaToken`).
 */
export const signupFreeBodySchema = z.strictObject({
  name: accountNameSchema,
  email: accountEmailSchema,
  /**
   * The Turnstile token of the sign-up form (widget action TURNSTILE_ACTIONS.signupFree,
   * `signup_free`). Required when the api has CAPTCHA_PROVIDER=turnstile (web shows the widget
   * whenever its captcha config is `turnstile`); ignored otherwise. Missing or not accepted:
   * RATE_LIMITED with RateLimitedDetails `{ retryAfterSeconds: 0, captcha: { provider:
   * 'turnstile', action: 'signup_free', rejected } }` (`rejected` null when none was sent), the
   * shape face search uses; solve the widget again and resend.
   */
  captchaToken: captchaTokenSchema.optional(),
});
export type SignupFreeBody = z.input<typeof signupFreeBodySchema>;

/**
 * Free sign-up step 2: the token from the link (single use) and a password (photographer policy:
 * PASSWORD_TOO_WEAK, the token stays usable). Creates the photographer (`created_by` null,
 * `must_change_password` false), applies `free`, audits `account.self_signup`, and answers a new
 * normal session (the same shape as photographer sign-in and password-reset confirm) that the
 * BFF stores in its session cookie. SIGNUP_LINK_INVALID for an unknown, expired or used token, or
 * when the email got an account meanwhile.
 */
export const signupFreeConfirmBodySchema = z.strictObject({
  token: opaqueTokenSchema,
  password: newPasswordSchema,
});
export type SignupFreeConfirmBody = z.input<typeof signupFreeConfirmBodySchema>;

// --- POST /package-orders (bff, optional photographer token) -----------------------------------------

/** `Idempotency-Key` is required (VALIDATION_FAILED at `headers.idempotency-key` without it). */
export const createPackageOrderHeadersSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema,
});

/**
 * Start buying a paid package.
 * - Signed in (the BFF forwards the photographer's bearer token): `email` and `name` must be
 *   absent; the order is for that account (`photographer_id`, its email).
 * - Not signed in: `email` and `name` are required (VALIDATION_FAILED at `body.email` /
 *   `body.name` otherwise; the API checks this, the schema can't know the caller).
 * Refusals: PACKAGE_UNAVAILABLE, PAYMENT_UNAVAILABLE, EMAIL_UNAVAILABLE (see ErrorCode). Idempotent
 * per `Idempotency-Key` (globally unique): the same key with the same request returns the same
 * `orderId` and `redirectUrl` with a new `accessToken` (only the token's hash is stored, so the
 * old one stops working); the same key with another request is IDEMPOTENCY_KEY_REUSED.
 */
export const createPackageOrderBodySchema = z.strictObject({
  packageCode: packageCodeSchema,
  email: accountEmailSchema.optional(),
  name: accountNameSchema.optional(),
  /**
   * ADR 0030: a coupon (COUPON_INVALID, COUPON_USED_UP). The order then holds one of its uses for
   * PACKAGE_COUPON_HOLD_SECONDS; at 100% off it is settled at once (no gateway) and `redirectUrl`
   * is PACKAGE_CHECKOUT_RETURN_PATH.
   */
  couponCode: couponCodeSchema.optional(),
});
export type CreatePackageOrderBody = z.input<typeof createPackageOrderBodySchema>;

export const createPackageOrderResponseSchema = z.object({
  orderId: idSchema,
  /** 43-character base64url secret; the BFF puts it in PACKAGE_ORDER_COOKIE, never in a URL. */
  accessToken: opaqueTokenSchema,
  /** The gateway's hosted page (https), or PACKAGE_FAKE_CHECKOUT_PATH with the fake gateway. */
  redirectUrl: z.url({ protocol: /^https?$/ }),
});
export type CreatePackageOrderResponse = z.output<typeof createPackageOrderResponseSchema>;

// --- GET /package-orders/:id, POST /package-orders/:id/fake-result (bff) -------------------------------

/** The order's access token (ORDER_TOKEN_HEADER). Wrong or missing for the id: ORDER_NOT_FOUND. */
export const packageOrderTokenHeadersSchema = z.object({
  [ORDER_TOKEN_HEADER]: opaqueTokenSchema,
});

/**
 * One order, for /checkout/return polling. Works whatever PACKAGE_SALES is (a buyer can still see
 * the result after sales are switched off).
 */
export const packageOrderViewSchema = z.object({
  status: z.enum(PACKAGE_ORDER_STATUSES),
  packageCode: packageCodeSchema,
  packageName: z.string().min(1),
  /** What is (or was) charged, VAT included. */
  totalSatang: satangSchema,
  /** maskEmail(order email), e.g. `a***@example.com`. */
  emailMasked: z.string().min(1),
  /**
   * True when this order created the account (a "ตั้งรหัสผ่าน" email went out); false for an
   * existing account and before the order is paid.
   */
  accountCreated: z.boolean(),
  /** The account's current package expiry once `paid`; null otherwise. */
  expiresAt: isoDateTimeSchema.nullable(),
  /**
   * ADR 0029: what the pay page (PACKAGE_PAY_PATH) may offer now: the gateway's `paymentMethods`
   * while the order is `pending` or `failed` and its gateway is the configured one; else empty.
   */
  paymentMethods: z.array(z.enum(PACKAGE_PAYMENT_METHODS)),
  /**
   * ADR 0030: the order's coupon, with the total it would have been without it (VAT included);
   * null without a coupon.
   */
  coupon: z
    .object({ code: z.string().regex(COUPON_CODE_PATTERN), listTotalSatang: satangSchema })
    .nullable(),
});
export type PackageOrderView = z.output<typeof packageOrderViewSchema>;

// --- POST /package-coupons/check (bff) --------------------------------------------------------------

/**
 * ADR 0030: what a coupon makes a package cost, for the buy dialog. Holds nothing (the order does,
 * when it is created). COUPON_INVALID, COUPON_USED_UP; PACKAGE_UNAVAILABLE as POST /package-orders;
 * RATE_LIMITED past PACKAGE_COUPON_CHECK_RATE_PER_IP.
 */
export const checkPackageCouponBodySchema = z.strictObject({
  packageCode: packageCodeSchema,
  couponCode: couponCodeSchema,
});
export type CheckPackageCouponBody = z.input<typeof checkPackageCouponBodySchema>;

export const checkPackageCouponResponseSchema = z.object({
  couponCode: z.string().regex(COUPON_CODE_PATTERN),
  percentOff: couponPercentSchema,
  /** The package's total without the coupon (VAT included). */
  listTotalSatang: satangSchema,
  /** The amounts the order will charge (discountedPackageTotal). */
  price: packageTotalSchema,
});
export type CheckPackageCouponResponse = z.output<typeof checkPackageCouponResponseSchema>;

/**
 * The fake gateway's result buttons (PACKAGE_GATEWAY=fake only; any other gateway: NOT_FOUND).
 * Applied through the same transaction as a webhook; idempotent like it (a paid order stays
 * paid). Answers the order as GET /package-orders/:id would.
 */
export const packageOrderFakeResultBodySchema = z.strictObject({
  result: z.enum(['paid', 'failed']),
});
export type PackageOrderFakeResultBody = z.input<typeof packageOrderFakeResultBodySchema>;

// --- POST /package-orders/:id/pay (bff) ---------------------------------------------------------------

/**
 * ADR 0029: one payment attempt from the pay page. PAYMENT_UNAVAILABLE when the method isn't in
 * the order's `paymentMethods` (or the order is paid); RATE_LIMITED past PACKAGE_PAY_RATE_PER_ORDER;
 * PAYMENT_GATEWAY_ERROR when the gateway refuses or doesn't answer.
 */
export const startPackagePaymentBodySchema = z.strictObject({
  method: z.enum(PACKAGE_PAYMENT_METHODS),
});
export type StartPackagePaymentBody = z.input<typeof startPackagePaymentBodySchema>;

export const startPackagePaymentResponseSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('qr'),
    /** `data:image/png;base64,...`: the PromptPay QR to show. */
    qrImage: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
    /** The QR can't be paid after this. */
    expiresAt: isoDateTimeSchema,
  }),
  z.object({
    method: z.literal('card'),
    /** The gateway's hosted card form. */
    redirectUrl: z.url({ protocol: /^https$/ }),
  }),
]);
export type StartPackagePaymentResponse = z.output<typeof startPackagePaymentResponseSchema>;

// --- POST /package-payments/webhooks/:gateway (webhook) -----------------------------------------------

/**
 * `:gateway` must be the configured PACKAGE_GATEWAY (anything else, or `off`: NOT_FOUND). The body
 * is read raw and verified by the adapter (verifyCallback) before parsing. Answers
 * webhookResponseSchema (`{ received: true }`) once verified and handled, also for a duplicate.
 */
export const packageWebhookParamsSchema = z.object({ gateway: z.enum(PACKAGE_PAYMENT_GATEWAYS) });

// --- GET /me/package (photographer) ------------------------------------------------------------------

/** The signed-in photographer's package; `null` (JSON null) when the account is unlimited. */
export const myPackageSchema = z.object({
  code: packageCodeSchema,
  name: z.string().min(1),
  startsAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  photoLimit: z.number().int().positive(),
  photosUsed: z.number().int().nonnegative(),
  /** packageExpired(row, now). */
  expired: z.boolean(),
});
export type MyPackage = z.output<typeof myPackageSchema>;

export const myPackageResponseSchema = myPackageSchema.nullable();
export type MyPackageResponse = z.output<typeof myPackageResponseSchema>;
