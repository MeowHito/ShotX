import { createHash } from 'node:crypto';
import type {
  ChargeSavedMethodInput,
  ChargeSavedMethodResult,
  PaymentGateway,
  PaymentGatewayAdapter,
  PaymentGatewayConfig,
} from '@shotx/shared';

/**
 * The part of the payment gateway adapter the worker uses: off-session charges of a saved card
 * for auto-renew. Checkout, webhooks and cancelling live in the api.
 */
export type RenewalGateway = Pick<PaymentGatewayAdapter, 'name' | 'chargeSavedMethod'>;

/** The configured gateway has no worker adapter yet; nothing was charged. */
export class PaymentGatewayUnavailableError extends Error {
  override readonly name = 'PaymentGatewayUnavailableError';
}

/**
 * PAYMENT_GATEWAY=omise|2c2p. Placeholder until their adapters exist: every charge throws before
 * reaching the gateway, so the daily job records nothing and retries on the next run (the
 * subscription runs into grace meanwhile, which is the safe direction).
 */
export class UnavailableRenewalGateway implements RenewalGateway {
  constructor(readonly name: PaymentGateway) {}

  chargeSavedMethod(): Promise<ChargeSavedMethodResult> {
    return Promise.reject(
      new PaymentGatewayUnavailableError(`no worker adapter for the ${this.name} gateway yet`),
    );
  }
}

/** One scripted outcome of FakeRenewalGateway. */
export type FakeChargeOutcome =
  | { status: 'paid' | 'pending' }
  | { status: 'failed'; failureCode?: string }
  /** The call never reached the gateway (network error before sending). Nothing is charged. */
  | { error: Error }
  /** The gateway charged, but the response was lost: the result is kept for a retry. */
  | { lostResponse: 'paid' | 'pending' | 'failed' };

/**
 * PAYMENT_GATEWAY=fake (development and tests; loadPaymentGatewayConfig refuses it in
 * production). Idempotent by `idempotencyKey` like a real gateway: a retry with the same key gets
 * the first result and the same `gatewayRef`. Unscripted charges use `defaultStatus`.
 */
export class FakeRenewalGateway implements RenewalGateway {
  readonly name = 'fake' as const;
  readonly calls: ChargeSavedMethodInput[] = [];
  /** Distinct charges made (one per idempotency key that reached the gateway). */
  readonly charges = new Map<string, ChargeSavedMethodResult & { amountSatang: number }>();
  defaultStatus: 'paid' | 'pending' | 'failed' = 'paid';
  private readonly script: FakeChargeOutcome[] = [];

  next(...outcomes: FakeChargeOutcome[]): this {
    this.script.push(...outcomes);
    return this;
  }

  chargeSavedMethod(input: ChargeSavedMethodInput): Promise<ChargeSavedMethodResult> {
    this.calls.push(input);
    const known = this.charges.get(input.idempotencyKey);
    if (known !== undefined) {
      return Promise.resolve({
        gatewayRef: known.gatewayRef,
        status: known.status,
        failureCode: known.failureCode,
      });
    }
    const outcome = this.script.shift() ?? { status: this.defaultStatus };
    if ('error' in outcome) return Promise.reject(outcome.error);
    const status = 'lostResponse' in outcome ? outcome.lostResponse : outcome.status;
    const result: ChargeSavedMethodResult = {
      gatewayRef: `fake_rn_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}`,
      status,
      failureCode:
        status === 'failed'
          ? (('failureCode' in outcome ? outcome.failureCode : undefined) ?? 'insufficient_fund')
          : null,
    };
    this.charges.set(input.idempotencyKey, { ...result, amountSatang: input.amountSatang });
    if ('lostResponse' in outcome) {
      return Promise.reject(new Error('fake gateway: response lost after charging'));
    }
    return Promise.resolve(result);
  }
}

export function createRenewalGateway(config: PaymentGatewayConfig): RenewalGateway {
  return config.gateway === 'fake'
    ? new FakeRenewalGateway()
    : new UnavailableRenewalGateway(config.gateway);
}
