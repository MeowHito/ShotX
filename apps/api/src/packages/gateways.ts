import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type MpayGatewaySettings,
  PACKAGE_FAKE_CHECKOUT_PATH,
  type PackageCallback,
  packageCallbackSchema,
  type PackageCheckoutInput,
  type PackageCheckoutResult,
  type PackageGatewayConfig,
  type PackagePaymentGateway,
  PaymentGatewayNotConfiguredError,
  type RawWebhookRequest,
} from '@shotx/shared';

// Package payment gateway adapters (ADR 0026 §5), selected by PACKAGE_GATEWAY:
// - `off`: no adapter at all (orders answer PAYMENT_UNAVAILABLE, the webhook NOT_FOUND);
// - `fake`: development and tests only (refused on APP_STAGE=prod by loadPackageGatewayConfig);
// - `mpay`: a skeleton until the merchant documentation arrives.
// The buyer pays on the gateway's hosted page: card and QR data never reach the API.

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

  inquire(gatewayRef: string): Promise<PackageCallback | null> {
    return Promise.resolve(this.inquiries.get(gatewayRef) ?? null);
  }
}

/**
 * mpay (ADR 0026 §5): a skeleton. It reads MPAY_API_URL, MPAY_MERCHANT_ID and MPAY_SECRET_KEY
 * (never logged) but can't talk to mpay yet: every call throws PaymentGatewayNotConfiguredError
 * (the order route answers PAYMENT_GATEWAY_ERROR) and verifyCallback answers false, so no callback
 * is ever applied.
 *
 * TODO(ADR 0026, mpay merchant docs): when mpay sends the merchant documentation and credentials,
 * implement against it:
 * - createCheckout: create a hosted payment for `orderId` (our reference, idempotent on mpay's
 *   side) with `amountSatang` in THB, `returnUrl` and `callbackUrl`; answer mpay's payment id as
 *   `gatewayRef` and its hosted page as `redirectUrl` (https only);
 * - verifyCallback: check mpay's signature over the exact raw body bytes with MPAY_SECRET_KEY in
 *   constant time, plus its timestamp tolerance if it has one;
 * - parseCallback: map mpay's payload to packageCallbackSchema (paid / failed / pending and the
 *   amount actually paid, in satang);
 * - inquire: mpay's payment status lookup by `gatewayRef`, if mpay has one.
 * Then add the contract tests with mpay's sample payloads (never real customer data).
 */
export class MpayPackageGateway implements PackagePaymentGateway {
  readonly name = 'mpay' as const;

  constructor(private readonly settings: MpayGatewaySettings) {}

  /** The configured mpay origin (for start-up logs; never the merchant id or the key). */
  get apiOrigin(): string {
    return new URL(this.settings.apiUrl).origin;
  }

  createCheckout(_input: PackageCheckoutInput): Promise<PackageCheckoutResult> {
    return Promise.reject(new PaymentGatewayNotConfiguredError('mpay'));
  }

  verifyCallback(_request: RawWebhookRequest): Promise<boolean> {
    return Promise.resolve(false);
  }

  parseCallback(_request: RawWebhookRequest): PackageCallback {
    throw new PaymentGatewayNotConfiguredError('mpay');
  }

  inquire(_gatewayRef: string): Promise<PackageCallback | null> {
    return Promise.reject(new PaymentGatewayNotConfiguredError('mpay'));
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
      return new MpayPackageGateway(config.mpay);
  }
}
