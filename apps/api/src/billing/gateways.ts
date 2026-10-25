import { createHash } from 'node:crypto';
import {
  type ChargeSavedMethodInput,
  type ChargeSavedMethodResult,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  fakeWebhookBodySchema,
  type NormalizedPaymentEvent,
  normalizedPaymentEventSchema,
  type PaymentGateway,
  type PaymentGatewayAdapter,
  type PaymentGatewayConfig,
  type RawWebhookRequest,
  verifyFakeWebhookSignature,
} from '@shotx/shared';
import type { Clock } from '../tokens';

/**
 * Payment gateway adapters (PaymentGatewayAdapter from @shotx/shared). Only the `fake` gateway is
 * implemented; `omise` and `2c2p` are stubs that throw until their adapters are written. Card
 * data never reaches the API: the card is entered on the gateway's hosted page, and only the
 * gateway's reference to the saved method comes back in the paid webhook.
 */

/** Thrown by the stubs; the billing service maps gateway errors to PAYMENT_GATEWAY_ERROR. */
export class PaymentGatewayNotConfiguredError extends Error {
  constructor(gateway: PaymentGateway) {
    super(`Payment gateway ${gateway} is not configured`);
    this.name = 'PaymentGatewayNotConfiguredError';
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The base of the fake gateway's hosted pages (https, as the contract requires). */
export const FAKE_GATEWAY_BASE_URL = 'https://pay.fake-gateway.test';

/**
 * A deterministic in-process gateway for development and tests (refused in production by
 * loadPaymentGatewayConfig). Charges are keyed by the idempotency key, so a retry returns the same
 * charge. Webhooks are signed per @shotx/shared billing/fake-gateway; tests sign them with
 * fakeWebhookSignatureHeader and the PAYMENT_FAKE_WEBHOOK_SECRET.
 */
export class FakePaymentGateway implements PaymentGatewayAdapter {
  readonly name = 'fake' as const;
  /** Every call, for assertions (no amounts or references of real people). */
  readonly calls: string[] = [];
  readonly canceled: string[] = [];
  private readonly charges = new Map<string, CreateCheckoutResult>();
  private failures: Partial<
    Record<'createCheckout' | 'cancelAutoRenew' | 'chargeSavedMethod', Error>
  > = {};

  constructor(
    private readonly secret: string,
    private readonly toleranceSeconds: number,
    private readonly clock: Clock,
  ) {}

  /** Makes the next call of `method` throw (a gateway outage). */
  failNext(
    method: 'createCheckout' | 'cancelAutoRenew' | 'chargeSavedMethod',
    error = new Error('gateway timeout'),
  ): void {
    this.failures[method] = error;
  }

  private maybeFail(method: 'createCheckout' | 'cancelAutoRenew' | 'chargeSavedMethod'): void {
    const error = this.failures[method];
    if (error !== undefined) {
      delete this.failures[method];
      throw error;
    }
  }

  /** The charge id the fake gateway gives an idempotency key. */
  static chargeRef(idempotencyKey: string): string {
    return `chrg_fake_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
  }

  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    this.calls.push(`createCheckout ${input.method}`);
    try {
      this.maybeFail('createCheckout');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('gateway error'));
    }
    const existing = this.charges.get(input.idempotencyKey);
    if (existing !== undefined) return Promise.resolve(existing);
    const gatewayRef = FakePaymentGateway.chargeRef(input.idempotencyKey);
    const result: CreateCheckoutResult =
      input.method === 'promptpay'
        ? {
            method: 'promptpay',
            gatewayRef,
            // Not a real EMVCo payload: the fake QR can't be paid by a banking app.
            qrPayload: `00020101021229370016A000000677010111FAKE${gatewayRef}5303764540${(
              input.amountSatang / 100
            ).toFixed(2)}5802TH6304FAKE`,
            qrImageDataUrl: null,
            expiresAt: input.expiresAt,
          }
        : {
            method: 'card',
            gatewayRef,
            redirectUrl: `${FAKE_GATEWAY_BASE_URL}/checkout/${gatewayRef}?return=${encodeURIComponent(
              input.returnUrl ?? '',
            )}`,
            expiresAt: input.expiresAt,
          };
    this.charges.set(input.idempotencyKey, result);
    return Promise.resolve(result);
  }

  chargeSavedMethod(input: ChargeSavedMethodInput): Promise<ChargeSavedMethodResult> {
    this.calls.push('chargeSavedMethod');
    try {
      this.maybeFail('chargeSavedMethod');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('gateway error'));
    }
    return Promise.resolve({
      gatewayRef: FakePaymentGateway.chargeRef(input.idempotencyKey),
      status: 'pending',
      failureCode: null,
    });
  }

  verifyWebhook(request: RawWebhookRequest): Promise<boolean> {
    return verifyFakeWebhookSignature({
      header: request.headers[FAKE_WEBHOOK_SIGNATURE_HEADER],
      rawBody: request.rawBody,
      secret: this.secret,
      now: this.clock.now(),
      toleranceSeconds: this.toleranceSeconds,
    });
  }

  parseWebhookEvent(request: RawWebhookRequest): NormalizedPaymentEvent | null {
    const body = fakeWebhookBodySchema.parse(JSON.parse(decoder.decode(request.rawBody)));
    return normalizedPaymentEventSchema.parse({
      gateway: 'fake',
      eventRef: body.id,
      gatewayRef: body.chargeId,
      type: body.type,
      amountSatang: body.amountSatang,
      currency: body.currency,
      occurredAt: new Date(body.occurredAt),
      paymentMethodRef: body.paymentMethodRef ?? null,
      failureCode: body.failureCode ?? null,
    });
  }

  cancelAutoRenew(input: { paymentMethodRef: string }): Promise<void> {
    this.calls.push('cancelAutoRenew');
    try {
      this.maybeFail('cancelAutoRenew');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('gateway error'));
    }
    this.canceled.push(input.paymentMethodRef);
    return Promise.resolve();
  }
}

/**
 * A placeholder for a real gateway whose adapter isn't written yet. Every call throws, and
 * verifyWebhook answers false, so nothing a caller sends is ever stored or applied.
 */
class UnconfiguredGateway implements PaymentGatewayAdapter {
  constructor(readonly name: PaymentGateway) {}

  createCheckout(): Promise<CreateCheckoutResult> {
    return Promise.reject(new PaymentGatewayNotConfiguredError(this.name));
  }

  chargeSavedMethod(): Promise<ChargeSavedMethodResult> {
    return Promise.reject(new PaymentGatewayNotConfiguredError(this.name));
  }

  verifyWebhook(): Promise<boolean> {
    return Promise.resolve(false);
  }

  parseWebhookEvent(): NormalizedPaymentEvent | null {
    throw new PaymentGatewayNotConfiguredError(this.name);
  }

  cancelAutoRenew(): Promise<void> {
    return Promise.reject(new PaymentGatewayNotConfiguredError(this.name));
  }
}

/** Opn Payments (Omise): PromptPay QR and cards. Not implemented yet. */
export class OmisePaymentGateway extends UnconfiguredGateway {
  constructor() {
    super('omise');
  }
}

/** 2C2P: PromptPay QR and cards. Not implemented yet. */
export class TwoC2PPaymentGateway extends UnconfiguredGateway {
  constructor() {
    super('2c2p');
  }
}

/** The adapter PAYMENT_GATEWAY selects. */
export function createPaymentGateway(
  config: PaymentGatewayConfig,
  clock: Clock,
): PaymentGatewayAdapter {
  switch (config.gateway) {
    case 'fake':
      return new FakePaymentGateway(
        config.secrets.PAYMENT_FAKE_WEBHOOK_SECRET ?? '',
        config.webhookToleranceSeconds,
        clock,
      );
    case 'omise':
      return new OmisePaymentGateway();
    case '2c2p':
      return new TwoC2PPaymentGateway();
  }
}
