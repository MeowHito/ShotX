import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  EMAIL_TEMPLATE_NAMES,
  EMAIL_TEMPLATES,
  type EmailMessage,
  type EmailTemplate,
  OffEmailProvider,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { memoryLogger, silentLogger } from '../logger';
import {
  createEmailProvider,
  FakeEmailProvider,
  formatFromAddress,
  SesEmailProvider,
} from './email';
import { EMAIL_MESSAGES_TH, formatBaht, formatBangkok, renderEmail } from './email-templates';
import {
  createRenewalGateway,
  FakeRenewalGateway,
  PaymentGatewayUnavailableError,
  UnavailableRenewalGateway,
} from './gateway';

const billingUrl = 'https://shotx.example/studio/billing';

const samples: { [T in EmailTemplate]: EmailMessage<T> } = {
  renewal_reminder: {
    to: 'p@example.com',
    template: 'renewal_reminder',
    locale: 'th',
    params: {
      planName: 'Standard',
      periodEnd: '2026-11-30T17:00:00.000Z',
      daysBefore: 7,
      autoRenew: true,
      renewalAmountSatang: 39_000,
      billingUrl,
    },
    idempotencyKey: 'notice:x',
  },
  payment_receipt: {
    to: 'p@example.com',
    template: 'payment_receipt',
    locale: 'th',
    params: {
      paymentId: '0b9f8f5e-8d1c-4d55-9a37-08a8a3e7a6f1',
      planName: 'Pro',
      changeType: 'renew',
      method: 'promptpay',
      totalSatang: 990_000,
      vatSatang: 64_766,
      netSatang: 925_234,
      paidAt: '2026-11-01T03:00:00.000Z',
      periodEnd: '2027-11-01T03:00:00.000Z',
      billingUrl,
    },
    idempotencyKey: 'receipt:x',
  },
  grace_started: {
    to: 'p@example.com',
    template: 'grace_started',
    locale: 'th',
    params: { graceEndsAt: '2026-12-14T17:00:00.000Z', billingUrl },
    idempotencyKey: 'notice:g',
  },
  subscription_expired: {
    to: 'p@example.com',
    template: 'subscription_expired',
    locale: 'th',
    params: { purgeAt: '2027-01-28T17:00:00.000Z', billingUrl },
    idempotencyKey: 'notice:e',
  },
  purge_warning: {
    to: 'p@example.com',
    template: 'purge_warning',
    locale: 'th',
    params: { purgeAt: '2027-01-28T17:00:00.000Z', billingUrl },
    idempotencyKey: 'notice:w',
  },
};

describe('Thai email templates', () => {
  it('has a subject and a body for every EMAIL_TEMPLATES key', () => {
    for (const template of EMAIL_TEMPLATE_NAMES) {
      expect(EMAIL_MESSAGES_TH[EMAIL_TEMPLATES[template].subjectKey]).toBeTypeOf('function');
      expect(EMAIL_MESSAGES_TH[EMAIL_TEMPLATES[template].bodyKey]).toBeTypeOf('function');
      const rendered = renderEmail(samples[template]);
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.text).toContain(billingUrl);
      // Thai copy, no leftover placeholders.
      expect(rendered.text).toMatch(/[฀-๿]/);
      expect(rendered.text).not.toMatch(/undefined|null|NaN|\$\{/);
    }
  });

  it('renders THB from satang and times on the Bangkok wall clock', () => {
    expect(formatBaht(14_900)).toBe('149.00 บาท');
    expect(formatBaht(2_290_000)).toBe('22,900.00 บาท');
    // 17:00Z is midnight in Bangkok, the next calendar day.
    expect(formatBangkok('2026-11-30T17:00:00.000Z')).toBe('1 ธันวาคม 2569 เวลา 00:00 น.');
    const receipt = renderEmail(samples.payment_receipt).text;
    expect(receipt).toContain('9,900.00 บาท');
    expect(receipt).toContain('647.66 บาท');
    expect(receipt).toContain('พร้อมเพย์');
    expect(receipt).toContain('ไม่ใช่ใบกำกับภาษีเต็มรูป');
    expect(renderEmail(samples.renewal_reminder).text).toContain('390.00 บาท');
    expect(
      renderEmail({
        ...samples.renewal_reminder,
        params: { ...samples.renewal_reminder.params, autoRenew: false, renewalAmountSatang: null },
      }).text,
    ).toContain('กรุณาต่ออายุ');
  });

  it('rejects parameters outside the strict schema (no card data or extras)', () => {
    expect(() =>
      renderEmail({
        ...samples.grace_started,
        params: { ...samples.grace_started.params, last4: '4242' } as never,
      }),
    ).toThrow();
  });
});

describe('email providers', () => {
  it('SES v2 SendEmail with UTF-8 Thai content and an encoded Thai sender name', async () => {
    const sent: SendEmailCommand[] = [];
    const provider = new SesEmailProvider(
      {
        send: (command) => {
          sent.push(command);
          return Promise.resolve({ MessageId: 'ses-1' });
        },
      },
      { address: 'no-reply@shotx.example', name: 'ช็อตเอ็กซ์' },
    );
    await expect(provider.send(samples.purge_warning)).resolves.toEqual({ messageId: 'ses-1' });
    const input = sent[0]!.input;
    expect(sent[0]).toBeInstanceOf(SendEmailCommand);
    expect(input.Destination).toEqual({ ToAddresses: ['p@example.com'] });
    expect(input.FromEmailAddress).toBe(
      `=?UTF-8?B?${Buffer.from('ช็อตเอ็กซ์').toString('base64')}?= <no-reply@shotx.example>`,
    );
    expect(input.Content?.Simple?.Subject).toEqual({
      Data: renderEmail(samples.purge_warning).subject,
      Charset: 'UTF-8',
    });
    expect(input.Content?.Simple?.Body?.Text?.Charset).toBe('UTF-8');
    expect(formatFromAddress({ address: 'a@b.example', name: 'Shot "X"' })).toBe(
      '"Shot \\"X\\"" <a@b.example>',
    );
  });

  it('selects SES or the fake from EMAIL_PROVIDER', () => {
    const from = { address: 'a@b.example', name: 'ShotX' };
    const client = { send: () => Promise.resolve({}) };
    expect(
      createEmailProvider({ provider: 'ses', from }, () => client, silentLogger),
    ).toBeInstanceOf(SesEmailProvider);
    expect(
      createEmailProvider(
        { provider: 'fake', from },
        () => {
          throw new Error('no SES client for the fake');
        },
        silentLogger,
      ),
    ).toBeInstanceOf(FakeEmailProvider);
  });

  it('EMAIL_PROVIDER=off drops every message and logs only the template', async () => {
    const log = memoryLogger();
    const off = createEmailProvider(
      { provider: 'off', from: null },
      () => {
        throw new Error('no SES client with off');
      },
      log,
    );
    expect(off).toBeInstanceOf(OffEmailProvider);
    for (const template of EMAIL_TEMPLATE_NAMES) {
      await expect(off.send(samples[template])).resolves.toEqual({
        messageId: 'email-off',
        dropped: true,
      });
    }
    expect(log.entries.map((e) => e.fields)).toEqual(
      EMAIL_TEMPLATE_NAMES.map((template) => ({
        event: 'email.dropped',
        provider: 'off',
        template,
      })),
    );
    const logged = JSON.stringify(log.entries);
    for (const template of EMAIL_TEMPLATE_NAMES) {
      const message = samples[template];
      expect(logged).not.toContain(message.to);
      expect(logged).not.toContain(message.idempotencyKey);
      expect(logged).not.toContain(renderEmail(message).subject);
    }
  });

  it('the fake records, fails on demand and flags duplicates', async () => {
    const fake = new FakeEmailProvider().failNext();
    await expect(fake.send(samples.grace_started)).rejects.toThrow();
    await fake.send(samples.grace_started);
    await fake.send(samples.grace_started);
    expect(fake.sent).toHaveLength(1);
    expect(fake.duplicates).toHaveLength(1);
  });
});

describe('renewal gateway adapters', () => {
  const input = {
    idempotencyKey: 'renewal:s:2026-12-01T00:00:00.000Z:1',
    paymentMethodRef: 'card_1',
    amountSatang: 39_000,
    currency: 'THB' as const,
    description: 'Snap standard 1 month renewal',
  };

  it('the fake is idempotent by key, scriptable, and keeps charges whose response was lost', async () => {
    const gateway = new FakeRenewalGateway().next({ lostResponse: 'paid' }, { status: 'failed' });
    await expect(gateway.chargeSavedMethod(input)).rejects.toThrow(/lost/);
    const retry = await gateway.chargeSavedMethod(input);
    expect(retry).toMatchObject({ status: 'paid', failureCode: null });
    const failed = await gateway.chargeSavedMethod({ ...input, idempotencyKey: 'other' });
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'insufficient_fund' });
    expect(gateway.charges.size).toBe(2);
    expect(retry.gatewayRef).not.toBe(failed.gatewayRef);
  });

  it('omise and 2c2p have no worker adapter yet and never pretend to charge', async () => {
    const config = { webhookToleranceSeconds: 300, secrets: {} };
    expect(createRenewalGateway({ ...config, gateway: 'fake' })).toBeInstanceOf(FakeRenewalGateway);
    const omise = createRenewalGateway({ ...config, gateway: 'omise' });
    expect(omise).toBeInstanceOf(UnavailableRenewalGateway);
    expect(omise.name).toBe('omise');
    await expect(omise.chargeSavedMethod(input)).rejects.toBeInstanceOf(
      PaymentGatewayUnavailableError,
    );
  });
});
