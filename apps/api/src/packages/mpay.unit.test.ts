import { createHmac } from 'node:crypto';
import type { MpayGatewaySettings } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import {
  MPAY_HEADERS,
  MPAY_PATHS,
  MpayPackageGateway,
  MpayRequestError,
  newGatewayAttemptRef,
} from './gateways';

// ADR 0029: the mPAY ONE adapter against sample payloads shaped like the spec's (v4.19), never
// real customer data.

const SETTINGS: MpayGatewaySettings = {
  apiUrl: 'https://mpay.example.test/prod/',
  merchantId: '5396508',
  secretKey: 'b983ab7b986w636f8e5a6e2999wu633',
  serviceId: '19100061935133847',
  methods: ['qr', 'card'],
  qrExpireSeconds: 600,
  timeoutMs: 5_000,
};
const ORDER_ID = '0190a0a0-0000-7000-8000-000000000001';
const NOW = new Date('2026-11-17T10:00:00.000Z');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5Mz';

const encode = (text: string) => new TextEncoder().encode(text);
const hmac = (body: string, nonce: string) =>
  createHmac('sha256', SETTINGS.secretKey)
    .update(body + nonce)
    .digest('hex');

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that records requests and answers from `answers` in turn. */
function fakeFetch(answers: { status?: number; body: unknown }[]) {
  const sent: Sent[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const url = input instanceof Request ? input.url : input.toString();
    sent.push({ url, headers, body: typeof init?.body === 'string' ? init.body : '' });
    const answer = answers.shift() ?? { status: 500, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 }),
    );
  }) as typeof fetch;
  return { fn, sent };
}

function gatewayWith(answers: { status?: number; body: unknown }[], settings = SETTINGS) {
  const fetch = fakeFetch(answers);
  const gateway = new MpayPackageGateway(
    settings,
    'https://snap.example.test',
    fetch.fn,
    () => NOW,
  );
  return { gateway, sent: fetch.sent };
}

const start = (method: 'qr' | 'card') => ({
  orderId: ORDER_ID,
  attemptRef: 'SNABCDEFGHJKLMNPQRS',
  method,
  amountSatang: 42_693,
  currency: 'THB' as const,
  description: 'Snap 3 Days',
  returnUrl: 'https://snap.example.test/checkout/back',
});

describe('newGatewayAttemptRef', () => {
  it('is 20 unambiguous characters starting with SN, and different each time', () => {
    const refs = new Set(Array.from({ length: 200 }, newGatewayAttemptRef));
    expect(refs.size).toBe(200);
    for (const ref of refs) expect(ref).toMatch(/^SN[A-HJ-NP-Z2-9]{18}$/);
  });
});

describe('MpayPackageGateway requests', () => {
  it('signs the exact body with the nonce and asks for a PromptPay QR', async () => {
    const { gateway, sent } = gatewayWith([
      { body: { order_id: 'SNABCDEFGHJKLMNPQRS', txn_id: 'T1', qr_img: PNG, amount: 426.93 } },
    ]);
    const result = await gateway.startPayment(start('qr'));
    expect(result).toEqual({
      method: 'qr',
      qrPngBase64: PNG,
      expiresAt: new Date(NOW.getTime() + 600_000),
    });
    const [request] = sent;
    expect(request?.url).toBe(`https://mpay.example.test/prod${MPAY_PATHS.qr}`);
    const nonce = request?.headers['X-sdpg-nonce'] ?? '';
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers['X-sdpg-merchant-id']).toBe('5396508');
    expect(request?.headers['X-sdpg-signature']).toBe(hmac(request?.body ?? '', nonce));
    expect(JSON.parse(request?.body ?? '')).toEqual({
      order_id: 'SNABCDEFGHJKLMNPQRS',
      product_name: 'Snap 3 Days',
      service_id: '19100061935133847',
      cust_id: ORDER_ID,
      amount: 426.93,
      currency: 'THB',
      ref_1: ORDER_ID,
      sof: 'PROMPTPAY',
      expire_time_seconds: 600,
    });
  });

  it('strips a data: prefix from the QR', async () => {
    const { gateway } = gatewayWith([{ body: { qr_img: `data:image/png;base64,${PNG}` } }]);
    expect(await gateway.startPayment(start('qr'))).toMatchObject({ qrPngBase64: PNG });
  });

  it('opens the hosted card form with 3-D Secure, coming back to the return URL', async () => {
    const formUrl = 'https://pay.mpay.example.test/form/abc';
    const { gateway, sent } = gatewayWith([{ body: { status: 'PENDING', form_url: formUrl } }]);
    expect(await gateway.startPayment(start('card'))).toEqual({
      method: 'card',
      redirectUrl: formUrl,
    });
    expect(sent[0]?.url).toBe(`https://mpay.example.test/prod${MPAY_PATHS.card}`);
    expect(JSON.parse(sent[0]?.body ?? '')).toMatchObject({
      channel_type: 'WEBSITE',
      form_type: 'FORM',
      is_remember: false,
      capture: true,
      '3ds': {
        '3ds_required': true,
        '3ds_url_success': 'https://snap.example.test/checkout/back',
        '3ds_url_fail': 'https://snap.example.test/checkout/back',
      },
    });
  });

  it("turns mPAY's refusals into MpayRequestError with its code only", async () => {
    // mPAY answers some refusals with HTTP 200 and an error body.
    const inactive = gatewayWith([
      { body: { error_code: 'INVALID_REQUEST', error: 'SofId inActive: [sofChannelInactive]' } },
    ]);
    await expect(inactive.gateway.startPayment(start('qr'))).rejects.toThrow(
      new MpayRequestError(MPAY_PATHS.qr, 'INVALID_REQUEST'),
    );
    const down = gatewayWith([{ status: 500, body: { error_code: 'GET_CHANNEL_ERROR' } }]);
    await expect(down.gateway.startPayment(start('card'))).rejects.toThrow(/GET_CHANNEL_ERROR/);
    const noForm = gatewayWith([{ body: { form_url: 'http://insecure.example.test' } }]);
    await expect(noForm.gateway.startPayment(start('card'))).rejects.toThrow(/NO_FORM_URL/);
    const noQr = gatewayWith([{ body: { qr_img: '' } }]);
    await expect(noQr.gateway.startPayment(start('qr'))).rejects.toThrow(/NO_QR_IMAGE/);
    const cardOff = gatewayWith([], { ...SETTINGS, methods: ['qr'] });
    await expect(cardOff.gateway.startPayment(start('card'))).rejects.toThrow(/METHOD_NOT_OFFERED/);
    expect(cardOff.sent).toHaveLength(0);
  });
});

describe('MpayPackageGateway callbacks', () => {
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      txn_id: 'T2217810403451221288',
      txn_type: 'PAYMENT',
      status: 'SUCCESS',
      status_code: 'SR0000',
      status_message: 'Success',
      order_id: 'SNABCDEFGHJKLMNPQRS',
      cust_id: ORDER_ID,
      service_id: SETTINGS.serviceId,
      channel_type: 'QR',
      amount: 426.93,
      amount_net: 426.93,
      amount_cust_fee: 0,
      currency: 'THB',
      ref_1: ORDER_ID,
      sof_type: 'SOF_PROMPTPAY',
      ...over,
    });
  const { gateway } = gatewayWith([]);
  const signed = (body: string, nonce = '4572616e48616d6d65724c61686176') => ({
    rawBody: encode(body),
    headers: {
      [MPAY_HEADERS.nonce]: nonce,
      [MPAY_HEADERS.merchantId]: SETTINGS.merchantId,
      [MPAY_HEADERS.signature]: hmac(body, nonce),
    },
  });

  it('verifies the signature over the exact bytes, as hex in any case or base64 of hex', async () => {
    const body = payload();
    const request = signed(body);
    expect(await gateway.verifyCallback(request)).toBe(true);
    const upper = request.headers[MPAY_HEADERS.signature].toUpperCase();
    const headers = (signature: string) => ({
      ...request.headers,
      [MPAY_HEADERS.signature]: signature,
    });
    expect(await gateway.verifyCallback({ ...request, headers: headers(upper) })).toBe(true);
    const base64 = Buffer.from(upper).toString('base64');
    expect(await gateway.verifyCallback({ ...request, headers: headers(base64) })).toBe(true);

    expect(await gateway.verifyCallback({ ...request, rawBody: encode(`${body} `) })).toBe(false);
    expect(await gateway.verifyCallback({ ...request, headers: headers('00'.repeat(32)) })).toBe(
      false,
    );
    expect(await gateway.verifyCallback({ ...request, headers: headers('nope') })).toBe(false);
    const noNonce = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => name !== MPAY_HEADERS.nonce),
    );
    expect(await gateway.verifyCallback({ ...request, headers: noNonce })).toBe(false);
    const otherMerchant = { ...request.headers, [MPAY_HEADERS.merchantId]: '1234567' };
    expect(await gateway.verifyCallback({ ...request, headers: otherMerchant })).toBe(false);
  });

  it('reads a successful payment as paid, by txn_id, with the amount in satang', () => {
    expect(gateway.parseCallback(signed(payload()))).toEqual({
      gatewayRef: 'T2217810403451221288',
      orderId: ORDER_ID,
      status: 'paid',
      amountSatang: 42_693,
    });
    expect(gateway.parseCallback(signed(payload({ amount: '1000' })))).toMatchObject({
      amountSatang: 100_000,
    });
  });

  it('keeps the order payable after a failure, a void or a refund (pending)', () => {
    for (const over of [
      { status: 'FAIL' },
      { status: 'AUTHORIZED' },
      { txn_type: 'VOID' },
      { txn_type: 'REFUND' },
    ]) {
      expect(gateway.parseCallback(signed(payload(over))).status, JSON.stringify(over)).toBe(
        'pending',
      );
    }
  });

  it('refuses bodies it can not read', () => {
    expect(() => gateway.parseCallback(signed('[]'))).toThrow();
    expect(() => gateway.parseCallback(signed(payload({ ref_1: 'not-an-order' })))).toThrow();
    expect(() => gateway.parseCallback(signed(payload({ currency: 'USD' })))).toThrow();
    expect(() => gateway.parseCallback(signed(payload({ amount: 'x' })))).toThrow();
  });
});

describe('MpayPackageGateway inquire', () => {
  const inquiry = (attemptRefs: string[]) => ({ orderId: ORDER_ID, gatewayRef: null, attemptRefs });

  it('asks about the newest attempts and answers the first successful payment', async () => {
    const { gateway, sent } = gatewayWith([
      { status: 400, body: { error_code: 'TXN_NOT_FOUND' } },
      {
        body: {
          order_id: 'B',
          txn_id: 'T9',
          txn_type: 'PAYMENT',
          status: 'SUCCESS',
          amount: 426.93,
          currency: 'THB',
        },
      },
    ]);
    expect(await gateway.inquire(inquiry(['A', 'B', 'C', 'D']))).toEqual({
      gatewayRef: 'T9',
      orderId: ORDER_ID,
      status: 'paid',
      amountSatang: 42_693,
    });
    expect(sent.map((r) => JSON.parse(r.body) as unknown)).toEqual([
      { order_id: 'A' },
      { order_id: 'B' },
    ]);
    expect(sent[0]?.url).toBe(`https://mpay.example.test/prod${MPAY_PATHS.enquiry}`);
  });

  it('answers null for no attempts or nothing paid, and throws only when mPAY never answered', async () => {
    expect(await gatewayWith([]).gateway.inquire(inquiry([]))).toBeNull();
    const pending = gatewayWith([
      { body: { status: 'PENDING', txn_type: 'PAYMENT', amount: 1, ref_1: ORDER_ID } },
      { status: 400, body: { error_code: 'TXN_NOT_FOUND' } },
    ]);
    expect(await pending.gateway.inquire(inquiry(['A', 'B']))).toBeNull();
    const down = gatewayWith([
      { status: 502, body: {} },
      { status: 502, body: {} },
    ]);
    await expect(down.gateway.inquire(inquiry(['A', 'B']))).rejects.toThrow(/HTTP_502/);
  });
});
