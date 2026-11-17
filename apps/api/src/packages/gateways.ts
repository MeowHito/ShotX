import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type MpayGatewaySettings,
  PACKAGE_FAKE_CHECKOUT_PATH,
  PACKAGE_PAY_PATH,
  type PackageCallback,
  packageCallbackSchema,
  type PackageCheckoutInput,
  type PackageCheckoutResult,
  type PackageGatewayConfig,
  type PackageInquiry,
  type PackagePaymentGateway,
  type PackagePaymentMethod,
  type PackagePaymentStart,
  type PackagePaymentStartInput,
  type RawWebhookRequest,
} from '@shotx/shared';

// Package payment gateway adapters (ADR 0026 §5), selected by PACKAGE_GATEWAY:
// - `off`: no adapter at all (orders answer PAYMENT_UNAVAILABLE, the webhook NOT_FOUND);
// - `fake`: development and tests only (refused on APP_STAGE=prod by loadPackageGatewayConfig);
// - `mpay`: mPAY ONE (ADR 0029) behind Snap's own pay page (PromptPay QR, hosted card form).
// Card data never reaches Snap: cards are typed on mPAY's form.

/** Header of a fake gateway callback: hex HMAC-SHA256 of the raw body with the adapter's secret. */
export const FAKE_PACKAGE_SIGNATURE_HEADER = 'x-fake-package-signature';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The gateway reference the fake gateway gives an order. */
export function fakePackageGatewayRef(orderId: string): string {
  return `fake_${orderId}`;
}

/**
 * The fake gateway. `createCheckout` points the browser at web's fake hosted page
 * (`/checkout/fake?order=<id>` on PUBLIC_BASE_URL), whose buttons call
 * `POST /package-orders/:id/fake-result`. Callbacks are signed with a secret that only this
 * process knows (random per start unless a test passes one), so outside callers can't forge one.
 * `inquire` answers what a test set with `setInquiry` (null otherwise: still pending).
 */
export class FakePackageGateway implements PackagePaymentGateway {
  readonly name = 'fake' as const;
  /** Checkouts created, by order id (tests). */
  readonly checkouts: PackageCheckoutInput[] = [];
  private readonly inquiries = new Map<string, PackageCallback>();
  private failNextCheckout: Error | null = null;

  constructor(
    private readonly webBaseUrl: string,
    private readonly secret: Buffer = randomBytes(32),
  ) {}

  /** The fake signature of `rawBody` (tests sign callbacks with it). */
  sign(rawBody: string | Uint8Array): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  /** Makes the next createCheckout throw (a gateway outage). */
  failNext(error = new Error('fake gateway timeout')): void {
    this.failNextCheckout = error;
  }

  /** What `inquire(gatewayRef)` answers from now on. */
  setInquiry(gatewayRef: string, result: PackageCallback): void {
    this.inquiries.set(gatewayRef, result);
  }

  createCheckout(input: PackageCheckoutInput): Promise<PackageCheckoutResult> {
    const failure = this.failNextCheckout;
    if (failure !== null) {
      this.failNextCheckout = null;
      return Promise.reject(failure);
    }
    this.checkouts.push(input);
    const url = new URL(PACKAGE_FAKE_CHECKOUT_PATH, this.webBaseUrl);
    url.searchParams.set('order', input.orderId);
    return Promise.resolve({
      gatewayRef: fakePackageGatewayRef(input.orderId),
      redirectUrl: url.toString(),
    });
  }

  verifyCallback(request: RawWebhookRequest): Promise<boolean> {
    const presented = request.headers[FAKE_PACKAGE_SIGNATURE_HEADER];
    if (presented === undefined || !/^[0-9a-f]{64}$/.test(presented)) {
      return Promise.resolve(false);
    }
    const expected = Buffer.from(this.sign(request.rawBody), 'hex');
    return Promise.resolve(timingSafeEqual(Buffer.from(presented, 'hex'), expected));
  }

  parseCallback(request: RawWebhookRequest): PackageCallback {
    return packageCallbackSchema.parse(JSON.parse(decoder.decode(request.rawBody)));
  }

  inquire(order: PackageInquiry): Promise<PackageCallback | null> {
    return Promise.resolve(
      order.gatewayRef === null ? null : (this.inquiries.get(order.gatewayRef) ?? null),
    );
  }
}

/** mPAY ONE paths (spec v4.19 §3, §7, §8). */
export const MPAY_PATHS = {
  qr: '/service-txn-gateway/v1/qr',
  card: '/service-txn-gateway/v1/cc/txns/payment_order',
  enquiry: '/service-txn-gateway/v1/enquiry',
} as const;

/** mPAY's request and callback headers (lowercase, as Node sees them). */
export const MPAY_HEADERS = {
  nonce: 'x-sdpg-nonce',
  merchantId: 'x-sdpg-merchant-id',
  signature: 'x-sdpg-signature',
} as const;

/** mPAY's `order_id` is at most 20 characters and unique per merchant: one per attempt. */
const ATTEMPT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ATTEMPT_PREFIX = 'SN';
const ATTEMPT_LENGTH = 20;

/** A new gateway attempt id: `SN` + 18 random characters of an unambiguous alphabet. */
export function newGatewayAttemptRef(): string {
  const bytes = randomBytes(ATTEMPT_LENGTH - ATTEMPT_PREFIX.length);
  let ref = ATTEMPT_PREFIX;
  // 256 is a multiple of 32: every character is equally likely.
  for (const byte of bytes) ref += ATTEMPT_ALPHABET[byte % ATTEMPT_ALPHABET.length];
  return ref;
}

/** At most this many attempts are asked about per inquiry (the newest). */
const MPAY_ENQUIRY_ATTEMPTS = 3;

/** An mPAY refusal or an unreadable answer: `code` is mPAY's error code or the HTTP status. */
export class MpayRequestError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(`mPAY ${path} failed: ${code}`);
    this.name = 'MpayRequestError';
  }
}

type Json = Record<string, unknown>;

function isJsonObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : null;

/** mPAY amounts are THB with two decimals; Snap keeps integer satang. */
function satangOf(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isFinite(amount) || amount < 0) throw new Error('mPAY amount is not a number');
  return Math.round(amount * 100);
}

const bahtOf = (satang: number): number => Number((satang / 100).toFixed(2));

/**
 * mPAY ONE (ADR 0029; "mPAY ONE API Specification" v4.19). Snap's own pay page offers
 * MPAY_METHODS: `qr` (PromptPay, `POST /v1/qr`, the QR shown on the page) and `card` (the hosted
 * card form, `POST /v1/cc/txns/payment_order` with `form_type` FORM and 3-D Secure).
 *
 * - Requests carry `X-sdpg-nonce` (a UUID), `X-sdpg-merchant-id` and `X-sdpg-signature` =
 *   lowercase hex HMAC-SHA256(MPAY_SECRET_KEY, body + nonce) over the exact bytes sent.
 * - Each attempt has its own mPAY `order_id` (newGatewayAttemptRef, chosen by the api); `ref_1` is
 *   always Snap's order id, which is how a callback finds the order.
 * - Callbacks (Payment Notify) are verified with the same formula over the raw body. Only a
 *   SUCCESS PAYMENT counts (`paid`, gatewayRef = mPAY's `txn_id`); FAIL and anything else are
 *   `pending`, so the buyer can try again; voids and refunds are made in mPAY's back office and
 *   are ignored here.
 * - `inquire` asks `POST /v1/enquiry` about the newest attempts.
 * The merchant id and the key are never logged.
 */
export class MpayPackageGateway implements PackagePaymentGateway {
  readonly name = 'mpay' as const;
  readonly paymentMethods: readonly PackagePaymentMethod[];
  private readonly baseUrl: string;

  constructor(
    private readonly settings: MpayGatewaySettings,
    private readonly webBaseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.paymentMethods = settings.methods;
    this.baseUrl = settings.apiUrl.replace(/\/+$/, '');
  }

  /** The configured mpay origin (for start-up logs; never the merchant id or the key). */
  get apiOrigin(): string {
    return new URL(this.settings.apiUrl).origin;
  }

  /** Lowercase hex HMAC-SHA256(secret, body + nonce). */
  sign(body: string | Uint8Array, nonce: string): string {
    return createHmac('sha256', this.settings.secretKey)
      .update(body)
      .update(nonce, 'utf8')
      .digest('hex');
  }

  /** The order goes to Snap's pay page; nothing is sent to mPAY until a method is picked. */
  createCheckout(input: PackageCheckoutInput): Promise<PackageCheckoutResult> {
    const url = new URL(PACKAGE_PAY_PATH, this.webBaseUrl);
    url.searchParams.set('order', input.orderId);
    return Promise.resolve({ gatewayRef: null, redirectUrl: url.toString() });
  }

  async startPayment(input: PackagePaymentStartInput): Promise<PackagePaymentStart> {
    if (!this.paymentMethods.includes(input.method)) {
      throw new MpayRequestError(input.method, 'METHOD_NOT_OFFERED');
    }
    const common = {
      order_id: input.attemptRef,
      product_name: input.description,
      service_id: this.settings.serviceId,
      cust_id: input.orderId,
      amount: bahtOf(input.amountSatang),
      currency: input.currency,
      ref_1: input.orderId,
    };
    if (input.method === 'qr') {
      const answer = await this.post(MPAY_PATHS.qr, {
        ...common,
        sof: 'PROMPTPAY',
        expire_time_seconds: this.settings.qrExpireSeconds,
      });
      const image = text(answer.qr_img)?.replace(/^data:image\/[a-z]+;base64,/, '') ?? null;
      if (image === null || !/^[A-Za-z0-9+/=]+$/.test(image)) {
        throw new MpayRequestError(MPAY_PATHS.qr, 'NO_QR_IMAGE');
      }
      return {
        method: 'qr',
        qrPngBase64: image,
        expiresAt: new Date(this.now().getTime() + this.settings.qrExpireSeconds * 1000),
      };
    }
    const answer = await this.post(MPAY_PATHS.card, {
      ...common,
      channel_type: 'WEBSITE',
      form_type: 'FORM',
      is_remember: false,
      capture: true,
      '3ds': {
        '3ds_required': true,
        '3ds_url_success': input.returnUrl,
        '3ds_url_fail': input.returnUrl,
      },
    });
    const formUrl = text(answer.form_url);
    if (formUrl === null || !URL.canParse(formUrl) || new URL(formUrl).protocol !== 'https:') {
      throw new MpayRequestError(MPAY_PATHS.card, 'NO_FORM_URL');
    }
    return { method: 'card', redirectUrl: formUrl };
  }

  /**
   * The signature over the exact raw body (constant time). Accepts it as hex in either case, or
   * as base64 of that hex (the spec's examples show both); a merchant id header, when sent, must
   * be ours.
   */
  verifyCallback(request: RawWebhookRequest): Promise<boolean> {
    const nonce = request.headers[MPAY_HEADERS.nonce]?.trim();
    const presented = request.headers[MPAY_HEADERS.signature]?.trim();
    const merchant = request.headers[MPAY_HEADERS.merchantId]?.trim();
    if (nonce === undefined || nonce === '' || nonce.length > 200 || presented === undefined) {
      return Promise.resolve(false);
    }
    if (merchant !== undefined && merchant !== this.settings.merchantId) {
      return Promise.resolve(false);
    }
    let hex = presented;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      hex = /^[A-Za-z0-9+/]+={0,2}$/.test(presented)
        ? Buffer.from(presented, 'base64').toString('latin1')
        : '';
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return Promise.resolve(false);
    const expected = Buffer.from(this.sign(request.rawBody, nonce), 'hex');
    return Promise.resolve(timingSafeEqual(Buffer.from(hex, 'hex'), expected));
  }

  parseCallback(request: RawWebhookRequest): PackageCallback {
    const body: unknown = JSON.parse(decoder.decode(request.rawBody));
    if (!isJsonObject(body)) throw new Error('mPAY callback is not an object');
    return this.toCallback(body);
  }

  /** The first SUCCESS PAYMENT among the newest attempts; null when none (or none known). */
  async inquire(order: PackageInquiry): Promise<PackageCallback | null> {
    let lastError: unknown = null;
    let answered = false;
    for (const attemptRef of order.attemptRefs.slice(0, MPAY_ENQUIRY_ATTEMPTS)) {
      try {
        const answer = await this.post(MPAY_PATHS.enquiry, { order_id: attemptRef });
        answered = true;
        const callback = this.toCallback({ ref_1: order.orderId, ...answer });
        if (callback.status === 'paid') return callback;
      } catch (error) {
        if (error instanceof MpayRequestError && /not.?found/i.test(error.code)) {
          answered = true; // an attempt mPAY never created (its request failed)
          continue;
        }
        lastError = error;
      }
    }
    if (!answered && lastError !== null) {
      throw lastError instanceof Error ? lastError : new MpayRequestError('enquiry', 'UNKNOWN');
    }
    return null;
  }

  /** mPAY's payment result (callback or enquiry) as Snap understands it. */
  private toCallback(body: Json): PackageCallback {
    const currency = text(body.currency);
    if (currency !== null && currency !== 'THB') throw new Error('mPAY currency is not THB');
    const status = text(body.status)?.toUpperCase();
    const txnType = text(body.txn_type)?.toUpperCase() ?? 'PAYMENT';
    return packageCallbackSchema.parse({
      gatewayRef: text(body.txn_id) ?? text(body.order_id),
      orderId: text(body.ref_1),
      status: status === 'SUCCESS' && txnType === 'PAYMENT' ? 'paid' : 'pending',
      amountSatang: satangOf(body.amount),
    });
  }

  /** One signed request; mPAY's error (HTTP status or an `error_code` body) throws. */
  private async post(path: string, payload: Json): Promise<Json> {
    const body = JSON.stringify(payload);
    const nonce = randomUUID();
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'X-sdpg-nonce': nonce,
          'X-sdpg-merchant-id': this.settings.merchantId,
          'X-sdpg-signature': this.sign(body, nonce),
        },
        body,
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (error) {
      throw new MpayRequestError(path, error instanceof Error ? error.name : 'NETWORK');
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const json = isJsonObject(parsed) ? parsed : null;
    const errorCode = json === null ? null : (text(json.error_code) ?? text(json.errorCode));
    if (!response.ok || json === null || errorCode !== null) {
      throw new MpayRequestError(path, errorCode ?? `HTTP_${response.status}`);
    }
    return json;
  }
}

/** The adapter PACKAGE_GATEWAY selects; null with `off` (nothing is built). */
export function createPackageGateway(
  config: PackageGatewayConfig,
  webBaseUrl: string,
): PackagePaymentGateway | null {
  switch (config.gateway) {
    case 'off':
      return null;
    case 'fake':
      return new FakePackageGateway(webBaseUrl);
    case 'mpay':
      return new MpayPackageGateway(config.mpay, webBaseUrl);
  }
}
