import { z } from 'zod';
import { PAYMENT_EVENT_TYPES } from '../domain';
import { satangSchema } from './money';

/**
 * The `fake` gateway's webhook signature, for development and tests (production refuses the fake
 * gateway). Header {@link FAKE_WEBHOOK_SIGNATURE_HEADER}:
 *
 *   t=<unix seconds>,v1=<lowercase hex HMAC-SHA256(PAYMENT_FAKE_WEBHOOK_SECRET, "<t>.<raw body>")>
 *
 * The body is UTF-8 JSON of {@link fakeWebhookBodySchema}. A signature older or newer than
 * PAYMENT_WEBHOOK_TOLERANCE_SECONDS is rejected (replay protection). Same scheme as Stripe's, so
 * the real adapters' verification paths look alike.
 */
export const FAKE_WEBHOOK_SIGNATURE_HEADER = 'x-fake-signature';

export const fakeWebhookBodySchema = z.strictObject({
  /** Unique per event; the fake gateway's event id. */
  id: z.string().min(1).max(255),
  /** The charge (`payments.gateway_ref`). */
  chargeId: z.string().min(1).max(255),
  type: z.enum(PAYMENT_EVENT_TYPES),
  amountSatang: satangSchema,
  currency: z.literal('THB'),
  occurredAt: z.iso.datetime({ offset: true }),
  /** The saved card on a paid card charge. */
  paymentMethodRef: z.string().min(1).max(255).nullable().default(null),
  failureCode: z.string().min(1).max(64).nullable().default(null),
});
export type FakeWebhookBody = z.input<typeof fakeWebhookBodySchema>;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Lowercase hex HMAC-SHA256 of `"<timestamp>.<rawBody>"` (Web Crypto: Node and browsers). */
export async function fakeWebhookSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: Uint8Array,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = concat(encoder.encode(`${timestampSeconds}.`), rawBody);
  return toHex(await globalThis.crypto.subtle.sign('HMAC', key, signed));
}

/** The header value for a body signed at `timestampSeconds` (tests and the local fake gateway). */
export async function fakeWebhookSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: Uint8Array,
): Promise<string> {
  return `t=${timestampSeconds},v1=${await fakeWebhookSignature(secret, timestampSeconds, rawBody)}`;
}

const HEADER = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when `header` is a valid signature of `rawBody` with `secret`, made within
 * `toleranceSeconds` of `now`. Malformed headers are false, never an exception.
 */
export async function verifyFakeWebhookSignature(input: {
  header: string | undefined;
  rawBody: Uint8Array;
  secret: string;
  now: Date;
  toleranceSeconds: number;
}): Promise<boolean> {
  const match = HEADER.exec(input.header ?? '');
  if (match === null) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(input.now.getTime() / 1000 - timestamp) > input.toleranceSeconds) return false;
  const expected = await fakeWebhookSignature(input.secret, timestamp, input.rawBody);
  return constantTimeEqual(expected, match[2] ?? '');
}
