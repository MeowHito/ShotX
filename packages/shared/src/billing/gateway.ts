import { z } from 'zod';
import { PAYMENT_EVENT_TYPES, PAYMENT_GATEWAYS, type PaymentGateway } from '../domain';
import { satangSchema } from './money';

/**
 * The payment gateway adapter. Types only: implementations (`FakePaymentGateway`, and later
 * `OmisePaymentGateway`, `TwoC2PPaymentGateway`) live in apps/api, selected by PAYMENT_GATEWAY
 * (loadPaymentGatewayConfig). Card data never reaches the platform: cards are entered on the
 * gateway's page (or its JS tokenizer) and only the gateway's reference to the saved method is
 * stored (`subscriptions.payment_method_ref`).
 */
export interface PaymentGatewayAdapter {
  readonly name: PaymentGateway;
  /**
   * Starts collecting `amountSatang`: a PromptPay QR (prepaid periods) or a card page that also
   * saves the card for auto-renew. Idempotent by `idempotencyKey` (the checkout id), so a retry
   * returns the same charge.
   */
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /**
   * Charges a saved method off-session (auto-renew, daily job). Idempotent by `idempotencyKey`
   * (`renewal:{subscriptionId}:{periodEnd ISO}:{attempt}`). The result is usually `pending`; the
   * webhook decides.
   */
  chargeSavedMethod(input: ChargeSavedMethodInput): Promise<ChargeSavedMethodResult>;
  /**
   * Checks the webhook's signature over the exact raw body bytes. Never parses before verifying.
   * False for a missing, malformed, wrong or stale signature (WEBHOOK_SIGNATURE_INVALID).
   */
  verifyWebhook(request: RawWebhookRequest): Promise<boolean>;
  /**
   * The verified body as one normalized event. Throws for a body it can't read (the API answers
   * 2xx anyway after storing the hash, so the gateway doesn't retry a body that will never parse,
   * and alerts). Returns null for event kinds the platform ignores (also 2xx).
   */
  parseWebhookEvent(request: RawWebhookRequest): NormalizedPaymentEvent | null;
  /**
   * Turns auto-renew off at the gateway: detaches or deletes the saved method so it can never be
   * charged again. Idempotent (an already-removed method is success).
   */
  cancelAutoRenew(input: { paymentMethodRef: string }): Promise<void>;
}

export interface CreateCheckoutInput {
  /** The checkout id: the gateway's idempotency key and our reference on its side. */
  idempotencyKey: string;
  method: 'promptpay' | 'card';
  amountSatang: number;
  currency: 'THB';
  /** Short ASCII description shown by the gateway, e.g. `ShotX standard 3 months`. */
  description: string;
  /** The gateway must refuse payment after this (QR expiry). */
  expiresAt: Date;
  /** Card only: where the gateway sends the browser back (BILLING_CARD_RETURN_PATH). */
  returnUrl: string | null;
  /** Card only: save the card for auto-renew (always true today). */
  saveCard: boolean;
  /** For the gateway's own receipts and fraud checks; may be null (LINE accounts). */
  customerEmail: string | null;
}

export type CreateCheckoutResult =
  | {
      method: 'promptpay';
      /** The gateway's charge id: `payments.gateway_ref`. */
      gatewayRef: string;
      /** The EMVCo PromptPay payload the QR encodes (web renders it if there is no image). */
      qrPayload: string;
      /** The gateway's QR image as a `data:image/png;base64,...` or `data:image/svg+xml...` URL. */
      qrImageDataUrl: string | null;
      expiresAt: Date;
    }
  | {
      method: 'card';
      gatewayRef: string;
      /** The gateway's hosted page (3-D Secure included). */
      redirectUrl: string;
      expiresAt: Date;
    };

export interface ChargeSavedMethodInput {
  idempotencyKey: string;
  paymentMethodRef: string;
  amountSatang: number;
  currency: 'THB';
  description: string;
}

export interface ChargeSavedMethodResult {
  gatewayRef: string;
  status: 'pending' | 'paid' | 'failed';
  /** The gateway's failure code when failed (e.g. `insufficient_fund`), for the event log. */
  failureCode: string | null;
}

/** What the API hands an adapter: the exact body bytes and the lowercase headers. */
export interface RawWebhookRequest {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string | undefined>>;
}

/**
 * A webhook as the platform understands it, whatever the gateway:
 * - `eventRef`: the gateway's event id, or `{gatewayRef}:{type}` when it has none. Webhooks are
 *   deduplicated by (gateway, eventRef) in `payment_webhook_events`; the payment is found by
 *   (gateway, gatewayRef), the UNIQUE key of `payments`.
 * - `type`: `paid`, `failed`, `expired` (an unpaid QR timed out) or `refunded`.
 * - `paymentMethodRef`: the saved card's reference on a paid card charge, else null.
 */
export const normalizedPaymentEventSchema = z.object({
  gateway: z.enum(PAYMENT_GATEWAYS),
  eventRef: z.string().min(1).max(255),
  gatewayRef: z.string().min(1).max(255),
  type: z.enum(PAYMENT_EVENT_TYPES),
  amountSatang: satangSchema,
  currency: z.literal('THB'),
  occurredAt: z.date(),
  paymentMethodRef: z.string().min(1).max(255).nullable(),
  failureCode: z.string().min(1).max(64).nullable(),
});
export type NormalizedPaymentEvent = z.output<typeof normalizedPaymentEventSchema>;

/**
 * Where the gateway's card page returns the browser: PUBLIC_BASE_URL + this + `?payment={id}`.
 * The studio page polls GET /billing/payments/:id; the return itself proves nothing.
 */
export const BILLING_CARD_RETURN_PATH = '/studio/billing/return';
