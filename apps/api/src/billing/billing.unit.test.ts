import {
  EMAIL_TEMPLATE_NAMES,
  EMAIL_TEMPLATES,
  type EmailMessage,
  type EmailTemplate,
  fakeWebhookSignatureHeader,
  loadPaymentGatewayConfig,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../config';
import { MemoryEventLog } from '../infra/events';
import { testEnv, TestClock } from '../testing/fakes';
import { checkoutRequestSha256 } from './billing.service';
import {
  createEmailProvider,
  EMAIL_MESSAGES_TH,
  FakeEmailProvider,
  formatThb,
  fromHeader,
  renderEmail,
  SesEmailProvider,
  sesV2Input,
} from './email';
import {
  createPaymentGateway,
  FakePaymentGateway,
  OmisePaymentGateway,
  PaymentGatewayNotConfiguredError,
  TwoC2PPaymentGateway,
} from './gateways';
import { WEBHOOK_PATH } from '../http/json-body';

const SECRET = 'unit-fake-webhook-secret-0123456789';
const URL_ = 'http://localhost:3000/studio/billing';

const SAMPLES: { [T in EmailTemplate]: EmailMessage<T>['params'] } = {
  renewal_reminder: {
    planName: 'Standard',
    periodEnd: '2026-11-25T05:00:00.000Z',
    daysBefore: 7,
    autoRenew: true,
    renewalAmountSatang: 39_000,
    billingUrl: URL_,
  },
  payment_receipt: {
    paymentId: '0195f3a2-af4b-7a7d-8e5c-6f7a8b9cadbe',
    planName: 'Pro',
    changeType: 'upgrade',
    method: 'promptpay',
    totalSatang: 42_050,
    vatSatang: 2_751,
    netSatang: 39_299,
    paidAt: '2026-10-25T05:00:00.000Z',
    periodEnd: '2026-11-09T05:00:00.000Z',
    billingUrl: URL_,
  },
  grace_started: { graceEndsAt: '2026-11-08T05:00:00.000Z', billingUrl: URL_ },
  subscription_expired: { purgeAt: '2026-12-23T05:00:00.000Z', billingUrl: URL_ },
  purge_warning: { purgeAt: '2026-12-23T05:00:00.000Z', billingUrl: URL_ },
};

function message<T extends EmailTemplate>(template: T): EmailMessage<T> {
  return {
    to: 'p@example.com',
    template,
    locale: 'th',
    params: SAMPLES[template],
    idempotencyKey: `k:${template}`,
  };
}

describe('email templates', () => {
  it('has Thai subject and body text for every template key', () => {
    for (const template of EMAIL_TEMPLATE_NAMES) {
      const keys = EMAIL_TEMPLATES[template];
      expect(Object.keys(EMAIL_MESSAGES_TH)).toEqual(
        expect.arrayContaining([keys.subjectKey, keys.bodyKey]),
      );
      const rendered = renderEmail(message(template));
      expect(rendered.subject).toMatch(/[฀-๿]/);
      expect(rendered.text).toMatch(/[฀-๿]/);
      expect(rendered.text).toContain(URL_);
    }
  });

  it('renders the receipt with the VAT split in THB and Bangkok time', () => {
    const { subject, text } = renderEmail(message('payment_receipt'));
    expect(subject).toBe('ใบเสร็จรับเงิน ShotX - Pro');
    expect(text).toContain('อัปเกรดแพ็กเกจ Pro');
    expect(text).toContain('ยอดรวม: 420.50 บาท');
    expect(text).toContain('ภาษีมูลค่าเพิ่ม: 27.51 บาท');
    expect(text).toContain('ยอดก่อนภาษีมูลค่าเพิ่ม: 392.99 บาท');
    expect(text).toContain('12:00'); // 05:00Z is noon in Bangkok
    expect(text).toContain('ไม่ใช่ใบกำกับภาษีเต็มรูป');
    expect(formatThb(149_000)).toBe('1,490.00');
  });

  it('refuses parameters outside the strict schema', () => {
    expect(() =>
      renderEmail({
        ...message('grace_started'),
        params: { ...SAMPLES.grace_started, cardLast4: '4242' } as never,
      }),
    ).toThrow();
  });

  it('builds the SESv2 SendEmail input (identity default configuration set)', async () => {
    const config = loadApiConfig(testEnv({ EMAIL_FROM_NAME: 'ShotX ภาพงานวิ่ง' })).email;
    const input = sesV2Input(config, message('purge_warning'));
    expect(input).toEqual({
      FromEmailAddress: fromHeader(config.from),
      Destination: { ToAddresses: ['p@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'ไฟล์ของคุณใกล้ถูกลบถาวร', Charset: 'UTF-8' },
          Body: { Text: { Data: renderEmail(message('purge_warning')).text, Charset: 'UTF-8' } },
        },
      },
    });
    expect(input).not.toHaveProperty('ConfigurationSetName');
    expect(fromHeader(config.from)).toMatch(
      /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <no-reply@photos\.example\.com>$/,
    );
    const sent: unknown[] = [];
    const ses = new SesEmailProvider(config, (i) => {
      sent.push(i);
      return Promise.resolve({ MessageId: 'm-1' });
    });
    expect(await ses.send(message('purge_warning'))).toEqual({ messageId: 'm-1' });
    expect(sent).toHaveLength(1);
    await expect(new SesEmailProvider(config).send(message('grace_started'))).rejects.toThrow(
      'not configured',
    );
    expect(createEmailProvider(config)).toBeInstanceOf(FakeEmailProvider);
    expect(createEmailProvider({ ...config, provider: 'ses' })).toBeInstanceOf(SesEmailProvider);
  });

  it('the fake provider dedupes by idempotency key and can fail', async () => {
    const fake = new FakeEmailProvider();
    await fake.send(message('grace_started'));
    await fake.send(message('grace_started'));
    expect(fake.sent).toHaveLength(1);
    fake.failNext = true;
    await expect(fake.send(message('grace_started'))).rejects.toThrow();
  });
});

describe('payment gateways', () => {
  const clock = new TestClock();
  const fake = new FakePaymentGateway(SECRET, 300, clock);
  const body = (overrides: Record<string, unknown> = {}) =>
    new TextEncoder().encode(
      JSON.stringify({
        id: 'evt_1',
        chargeId: 'chrg_1',
        type: 'paid',
        amountSatang: 14_900,
        currency: 'THB',
        occurredAt: '2026-10-25T05:00:00.000Z',
        ...overrides,
      }),
    );
  const sign = async (raw: Uint8Array, at = clock.now()) => ({
    rawBody: raw,
    headers: {
      'x-fake-signature': await fakeWebhookSignatureHeader(
        SECRET,
        Math.floor(at.getTime() / 1000),
        raw,
      ),
    },
  });

  it('creates idempotent PromptPay and card checkouts', async () => {
    const input = {
      idempotencyKey: 'checkout-1',
      method: 'promptpay' as const,
      amountSatang: 14_900,
      currency: 'THB' as const,
      description: 'ShotX starter',
      expiresAt: clock.now(),
      returnUrl: null,
      saveCard: false,
      customerEmail: null,
    };
    const a = await fake.createCheckout(input);
    expect(await fake.createCheckout(input)).toEqual(a);
    expect(a).toMatchObject({ method: 'promptpay', qrImageDataUrl: null });
    const card = await fake.createCheckout({
      ...input,
      idempotencyKey: 'checkout-2',
      method: 'card',
      returnUrl: 'http://localhost:3000/studio/billing/return?checkout=x',
      saveCard: true,
    });
    expect(card.method === 'card' && new URL(card.redirectUrl).protocol).toBe('https:');
    expect(card.gatewayRef).not.toBe(a.gatewayRef);
  });

  it('verifies signatures over the exact bytes within the tolerance', async () => {
    const raw = body();
    expect(await fake.verifyWebhook(await sign(raw))).toBe(true);
    expect(
      await fake.verifyWebhook({
        rawBody: body({ amountSatang: 1 }),
        headers: (await sign(raw)).headers,
      }),
    ).toBe(false);
    expect(
      await fake.verifyWebhook(await sign(raw, new Date(clock.now().getTime() - 301_000))),
    ).toBe(false);
    expect(await fake.verifyWebhook({ rawBody: raw, headers: {} })).toBe(false);
    expect(fake.parseWebhookEvent(await sign(raw))).toMatchObject({
      gateway: 'fake',
      eventRef: 'evt_1',
      gatewayRef: 'chrg_1',
      type: 'paid',
      amountSatang: 14_900,
      paymentMethodRef: null,
    });
    expect(() =>
      fake.parseWebhookEvent({ rawBody: new TextEncoder().encode('{'), headers: {} }),
    ).toThrow();
  });

  it('omise and 2c2p are stubs: calls throw, webhooks never verify', async () => {
    for (const stub of [new OmisePaymentGateway(), new TwoC2PPaymentGateway()]) {
      await expect(stub.cancelAutoRenew()).rejects.toBeInstanceOf(PaymentGatewayNotConfiguredError);
      await expect(stub.createCheckout()).rejects.toThrow('not configured');
      await expect(stub.chargeSavedMethod()).rejects.toThrow('not configured');
      expect(await stub.verifyWebhook()).toBe(false);
      expect(() => stub.parseWebhookEvent()).toThrow('not configured');
    }
  });

  it('selects the configured gateway; production refuses the fake one', () => {
    const gatewayConfig = (env: Record<string, string>) => {
      const config = loadPaymentGatewayConfig({ BILLING_MODE: 'gateway', ...env });
      if (config === null) throw new Error('BILLING_MODE=gateway must load a gateway');
      return config;
    };
    const fakeConfig = gatewayConfig({ PAYMENT_FAKE_WEBHOOK_SECRET: SECRET });
    expect(createPaymentGateway(fakeConfig, clock)).toBeInstanceOf(FakePaymentGateway);
    expect(
      createPaymentGateway(
        gatewayConfig({
          PAYMENT_GATEWAY: 'omise',
          PAYMENT_OMISE_PUBLIC_KEY: 'pkey_test_0123456789abcdef',
          PAYMENT_OMISE_SECRET_KEY: 'skey_test_0123456789abcdef',
          PAYMENT_OMISE_WEBHOOK_SECRET: 'whsec_test_0123456789abcdef',
        }),
        clock,
      ),
    ).toBeInstanceOf(OmisePaymentGateway);
    // The fake is refused only on the prod stage; NODE_ENV alone doesn't decide it.
    expect(() => loadApiConfig(testEnv({ APP_STAGE: 'prod' }))).toThrow(/PAYMENT_GATEWAY=fake/);
    expect(() => loadApiConfig(testEnv({ NODE_ENV: 'production' }))).not.toThrow();
  });

  it('BILLING_MODE=offline (ADR 0010) reads no gateway setting, even on prod', () => {
    // No secret, the fake gateway on prod: nothing is read, nothing is refused.
    expect(
      loadPaymentGatewayConfig({
        APP_STAGE: 'prod',
        BILLING_MODE: 'offline',
        PAYMENT_GATEWAY: 'fake',
      }),
    ).toBeNull();
    expect(loadPaymentGatewayConfig({ APP_STAGE: 'prod' })).toBeNull();
    const config = loadApiConfig(
      testEnv({ BILLING_MODE: 'offline', PAYMENT_FAKE_WEBHOOK_SECRET: '' }),
    );
    expect(config.paymentGateway).toBeNull();
    expect(config.billingMode.mode).toBe('offline');
    // Without BILLING_MODE the default is offline.
    const env = Object.fromEntries(
      Object.entries(testEnv()).filter(([name]) => name !== 'BILLING_MODE'),
    );
    expect(loadApiConfig(env).paymentGateway).toBeNull();
  });
});

describe('checkout request hash and raw webhook bodies', () => {
  it('hashes the canonical request, independent of key order', () => {
    const a = checkoutRequestSha256({
      planCode: 'pro',
      changeType: 'upgrade',
      payment: { method: 'promptpay', months: null },
    });
    const b = checkoutRequestSha256({
      payment: { months: null, method: 'promptpay' },
      changeType: 'upgrade',
      planCode: 'pro',
    } as never);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      checkoutRequestSha256({
        planCode: 'pro',
        changeType: 'upgrade',
        payment: { method: 'card', months: 1 },
      }),
    ).not.toBe(a);
  });

  it('reads only webhook routes raw', () => {
    expect(WEBHOOK_PATH.test('/api/billing/webhooks/fake')).toBe(true);
    expect(WEBHOOK_PATH.test('/api/billing/webhooks/fake/x')).toBe(false);
    expect(WEBHOOK_PATH.test('/api/billing/checkout')).toBe(false);
  });

  it('events keep `event` top-level and never let fields override it', () => {
    const log = new MemoryEventLog(() => new Date('2026-10-25T05:00:00Z'));
    log.warn('face_deletion.alert', { event: 'spoof', level: 'x', shareId: 's', count: 3 });
    expect(log.entries).toEqual([
      {
        level: 'warn',
        event: 'face_deletion.alert',
        timestamp: '2026-10-25T05:00:00.000Z',
        shareId: 's',
        count: 3,
      },
    ]);
  });
});
