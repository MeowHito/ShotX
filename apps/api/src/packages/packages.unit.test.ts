import { PaymentGatewayNotConfiguredError } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../testing/fakes';
import { packageSalesSummary } from '../wiring';
import {
  createPackageGateway,
  FAKE_PACKAGE_SIGNATURE_HEADER,
  FakePackageGateway,
  MpayPackageGateway,
} from './gateways';
import {
  accountExistsEmail,
  packageAddedEmail,
  setPasswordEmail,
  signupLinkEmail,
  thaiBaht,
} from './package-emails';
import { orderRequestHash, orderTokenHash, signupEmailKey } from './packages.service';
import { photographerAccountKey } from '../auth/photographer-sign-in';

// ADR 0026 pure parts: gateway selection and adapters, request hashing, and the Thai emails.

const MPAY = {
  PACKAGE_GATEWAY: 'mpay',
  MPAY_API_URL: 'https://mpay.example.test/api',
  MPAY_MERCHANT_ID: 'merchant-test',
  MPAY_SECRET_KEY: 'mpay-test-secret-0123456789',
};

const encode = (text: string) => new TextEncoder().encode(text);

describe('package config', () => {
  it('defaults to sales off and no gateway', () => {
    const config = testConfig();
    expect(config.packages.salesEnabled).toBe(false);
    expect(config.packageGateway).toEqual({ gateway: 'off' });
    expect(packageSalesSummary(config)).toBe('package sales: off, gateway=off');
    expect(createPackageGateway(config.packageGateway, config.app.publicBaseUrl)).toBeNull();
  });

  it('refuses the fake gateway on prod and never prints the mpay key', () => {
    expect(() => testConfig({ APP_STAGE: 'prod', PACKAGE_GATEWAY: 'fake' })).toThrow(/fake/);
    const config = testConfig({ ...MPAY, PACKAGE_SALES: 'on' });
    expect(packageSalesSummary(config)).toBe('package sales: on, gateway=mpay');
    expect(packageSalesSummary(config)).not.toContain('mpay-test-secret');
  });
});

describe('FakePackageGateway', () => {
  const gateway = new FakePackageGateway('http://localhost:3000', Buffer.alloc(32, 1));
  const body = JSON.stringify({
    gatewayRef: 'fake_x',
    orderId: '0190a0a0-0000-7000-8000-000000000001',
    status: 'paid',
    amountSatang: 42_693,
  });

  it("sends the browser to web's fake checkout page", async () => {
    const checkout = await gateway.createCheckout({
      orderId: '0190a0a0-0000-7000-8000-000000000001',
      amountSatang: 42_693,
      currency: 'THB',
      description: 'Snap 3 Days',
      returnUrl: 'http://localhost:3000/checkout/return',
      callbackUrl: 'http://localhost:3000/api/package-payments/webhooks/fake',
      customerEmail: 'buyer@example.test',
    });
    expect(checkout).toEqual({
      gatewayRef: 'fake_0190a0a0-0000-7000-8000-000000000001',
      redirectUrl: 'http://localhost:3000/checkout/fake?order=0190a0a0-0000-7000-8000-000000000001',
    });
  });

  it('verifies the signature over the exact bytes', async () => {
    const headers = { [FAKE_PACKAGE_SIGNATURE_HEADER]: gateway.sign(body) };
    expect(await gateway.verifyCallback({ rawBody: encode(body), headers })).toBe(true);
    expect(await gateway.verifyCallback({ rawBody: encode(`${body} `), headers })).toBe(false);
    expect(await gateway.verifyCallback({ rawBody: encode(body), headers: {} })).toBe(false);
    const other = new FakePackageGateway('http://localhost:3000');
    expect(await other.verifyCallback({ rawBody: encode(body), headers })).toBe(false);
    expect(gateway.parseCallback({ rawBody: encode(body), headers })).toMatchObject({
      status: 'paid',
      amountSatang: 42_693,
    });
    expect(() => gateway.parseCallback({ rawBody: encode('{}'), headers })).toThrow();
  });
});

describe('MpayPackageGateway (skeleton)', () => {
  const config = testConfig(MPAY);
  const gateway = createPackageGateway(config.packageGateway, config.app.publicBaseUrl);

  it('is built from MPAY_* and refuses everything until the merchant docs arrive', async () => {
    expect(gateway).toBeInstanceOf(MpayPackageGateway);
    if (!(gateway instanceof MpayPackageGateway)) return;
    expect(gateway.apiOrigin).toBe('https://mpay.example.test');
    await expect(
      gateway.createCheckout({
        orderId: '0190a0a0-0000-7000-8000-000000000001',
        amountSatang: 1,
        currency: 'THB',
        description: 'x',
        returnUrl: 'https://snap.example.test/checkout/return',
        callbackUrl: 'https://snap.example.test/api/package-payments/webhooks/mpay',
        customerEmail: 'buyer@example.test',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayNotConfiguredError);
    expect(await gateway.verifyCallback({ rawBody: encode('{}'), headers: {} })).toBe(false);
    expect(() => gateway.parseCallback({ rawBody: encode('{}'), headers: {} })).toThrow(
      PaymentGatewayNotConfiguredError,
    );
    await expect(gateway.inquire('ref')).rejects.toBeInstanceOf(PaymentGatewayNotConfiguredError);
  });
});

describe('order hashes', () => {
  it('treat email case and surrounding spaces as the same request', () => {
    const a = orderRequestHash({
      packageCode: 'd7',
      email: 'Buyer@Example.test',
      name: 'x',
      photographerId: null,
    });
    const b = orderRequestHash({
      packageCode: 'd7',
      email: ' buyer@example.test',
      name: 'x',
      photographerId: null,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      orderRequestHash({
        packageCode: 'd3',
        email: 'buyer@example.test',
        name: 'x',
        photographerId: null,
      }),
    ).not.toBe(a);
    expect(orderTokenHash('A'.repeat(43))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signupEmailKey', () => {
  it('is per normalized email and domain-separated from other HMACs of the secret', () => {
    const secret = 'test-ip-hash-secret-0123456789abcdef';
    const key = signupEmailKey(secret, 'Buyer@Example.test ');
    expect(key).toBe(signupEmailKey(secret, 'buyer@example.test'));
    expect(key).not.toBe(signupEmailKey(secret, 'other@example.test'));
    expect(key).not.toContain('buyer');
    expect(photographerAccountKey(secret, 'buyer@example.test')).not.toContain(key);
  });
});

describe('package emails', () => {
  it('never carry the typed name, and escape links in the HTML part', () => {
    const message = signupLinkEmail({
      to: 'a@example.test',
      link: 'http://localhost:3000/signup/confirm#token=abc&x=<y>',
      ttlHours: 24,
    });
    expect(message.html).not.toContain('x=<y>');
    expect(message.html).toContain('x=&#60;y&#62;');
    expect(message.text).toContain('24 ชั่วโมง');
    expect(message.subject).toContain('Snap');
  });

  it('show the package, expiry and amount, and say it is not a tax invoice', () => {
    const summary = {
      to: 'a@example.test',
      name: null,
      packageName: '30 Days',
      expiresAt: new Date('2026-12-16T05:00:00Z'),
      totalSatang: 138_993,
    };
    const set = setPasswordEmail({
      ...summary,
      link: 'http://x/reset-password#token=t',
      ttlDays: 7,
    });
    expect(set.text).toContain('30 Days');
    expect(set.text).toContain('1,389.93 บาท');
    expect(set.text).toContain('7 วัน');
    expect(set.text).toContain('ไม่ใช่ใบกำกับภาษี');
    const added = packageAddedEmail({ ...summary, studioUrl: 'http://x/studio' });
    expect(added.subject).toBe('เพิ่มแพ็กเกจแล้ว - Snap');
    expect(added.text).toContain('http://x/studio');
    const exists = accountExistsEmail({
      to: 'a@example.test',
      signInUrl: 'http://x/login',
      forgotPasswordUrl: 'http://x/forgot-password',
    });
    expect(exists.text).toContain('ลืมรหัสผ่าน');
    expect(thaiBaht(42_693)).toBe('426.93 บาท');
  });
});
