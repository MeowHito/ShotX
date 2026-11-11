import { randomUUID } from 'node:crypto';
import {
  BILLING_TIME_ZONE,
  EMAIL_TEMPLATE_PARAMS,
  EMAIL_TEMPLATES,
  type DroppedEmailLogEntry,
  type EmailConfig,
  type EmailMessage,
  type EmailProvider,
  type EmailSender,
  type EmailTemplate,
  OffEmailProvider,
  type SendingEmailConfig,
} from '@shotx/shared';
import type { z } from 'zod';

/**
 * Emails of the API (payment receipts) through the EmailProvider adapter of @shotx/shared. The
 * Thai subject and body of every template live here, keyed by EMAIL_TEMPLATES[t].subjectKey and
 * bodyKey (the worker keeps the same keys for the lifecycle emails it sends). Amounts are satang,
 * shown as THB with 2 decimals; times are shown in Asia/Bangkok. Parameters never contain card
 * data, biometrics or anything about viewers.
 */

type Params<T extends EmailTemplate> = z.output<(typeof EMAIL_TEMPLATE_PARAMS)[T]>;

/** `1490.00` style THB from satang (Thai grouping). */
export function formatThb(satang: number): string {
  return (satang / 100).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** A Bangkok wall-clock date and time, e.g. `25 ต.ค. 2569 12:00`. */
export function formatBangkok(iso: string): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: BILLING_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

const CHANGE_TYPE_TH = {
  new: 'สมัครแพ็กเกจ',
  renew: 'ต่ออายุแพ็กเกจ',
  upgrade: 'อัปเกรดแพ็กเกจ',
  downgrade: 'เปลี่ยนเป็นแพ็กเกจที่เล็กลง',
} as const;

const METHOD_TH = { promptpay: 'พร้อมเพย์', card: 'บัตรเครดิต/เดบิต' } as const;

/** Thai text by i18n key (`th` is the only locale). */
export const EMAIL_MESSAGES_TH: {
  [T in EmailTemplate as (typeof EMAIL_TEMPLATES)[T]['subjectKey']]: (p: Params<T>) => string;
} & {
  [T in EmailTemplate as (typeof EMAIL_TEMPLATES)[T]['bodyKey']]: (p: Params<T>) => string;
} = {
  'email.renewalReminder.subject': (p) =>
    `แพ็กเกจ ${p.planName} จะหมดอายุในอีก ${p.daysBefore} วัน`,
  'email.renewalReminder.body': (p) =>
    [
      `แพ็กเกจ ${p.planName} ของคุณจะหมดอายุวันที่ ${formatBangkok(p.periodEnd)}`,
      p.autoRenew
        ? `ระบบจะตัดเงินจากบัตรที่บันทึกไว้${
            p.renewalAmountSatang === null ? '' : ` จำนวน ${formatThb(p.renewalAmountSatang)} บาท`
          } เพื่อต่ออายุโดยอัตโนมัติ`
        : 'กรุณาต่ออายุเพื่ออัปโหลดรูปภาพต่อได้โดยไม่สะดุด',
      `จัดการแพ็กเกจ: ${p.billingUrl}`,
    ].join('\n\n'),
  'email.paymentReceipt.subject': (p) => `ใบเสร็จรับเงิน ShotX - ${p.planName}`,
  'email.paymentReceipt.body': (p) =>
    [
      'ขอบคุณสำหรับการชำระเงิน',
      [
        `รายการ: ${p.changeType === null ? 'ต่ออายุอัตโนมัติ' : CHANGE_TYPE_TH[p.changeType]} ${p.planName}`,
        `ชำระด้วย: ${METHOD_TH[p.method]}`,
        `ยอดก่อนภาษีมูลค่าเพิ่ม: ${formatThb(p.netSatang)} บาท`,
        `ภาษีมูลค่าเพิ่ม: ${formatThb(p.vatSatang)} บาท`,
        `ยอดรวม: ${formatThb(p.totalSatang)} บาท`,
        `วันที่ชำระ: ${formatBangkok(p.paidAt)}`,
        `ใช้งานได้ถึง: ${formatBangkok(p.periodEnd)}`,
        `เลขที่อ้างอิง: ${p.paymentId}`,
      ].join('\n'),
      'เอกสารนี้ไม่ใช่ใบกำกับภาษีเต็มรูป',
      `ดูรายละเอียด: ${p.billingUrl}`,
    ].join('\n\n'),
  'email.graceStarted.subject': () => 'แพ็กเกจของคุณหมดอายุแล้ว - หยุดการอัปโหลดชั่วคราว',
  'email.graceStarted.body': (p) =>
    [
      'แพ็กเกจของคุณหมดอายุแล้ว ระบบหยุดการอัปโหลดชั่วคราว แต่ลิงก์แชร์และการดาวน์โหลดยังใช้งานได้',
      `ต่ออายุก่อน ${formatBangkok(p.graceEndsAt)} เพื่อไม่ให้ลิงก์แชร์หมดอายุ`,
      `ต่ออายุ: ${p.billingUrl}`,
    ].join('\n\n'),
  'email.subscriptionExpired.subject': () => 'ลิงก์แชร์ของคุณหมดอายุแล้ว',
  'email.subscriptionExpired.body': (p) =>
    [
      'ระยะผ่อนผันสิ้นสุดแล้ว ลิงก์แชร์จะแสดงว่า "ลิงก์นี้หมดอายุ" คุณยังเข้าสู่ระบบ ต่ออายุ และดาวน์โหลดไฟล์ของคุณได้',
      `ไฟล์ทั้งหมดจะถูกลบถาวรในวันที่ ${formatBangkok(p.purgeAt)}`,
      `ต่ออายุ: ${p.billingUrl}`,
    ].join('\n\n'),
  'email.purgeWarning.subject': () => 'ไฟล์ของคุณใกล้ถูกลบถาวร',
  'email.purgeWarning.body': (p) =>
    [
      `ไฟล์ทั้งหมดในบัญชีของคุณจะถูกลบถาวรในวันที่ ${formatBangkok(p.purgeAt)}`,
      'ต่ออายุแพ็กเกจหรือดาวน์โหลดไฟล์ที่ต้องการเก็บไว้ก่อนวันดังกล่าว',
      `ต่ออายุ: ${p.billingUrl}`,
    ].join('\n\n'),
};

export interface RenderedEmail {
  subject: string;
  text: string;
}

/** Validates the params (strict schemas) and renders the Thai subject and body. */
export function renderEmail<T extends EmailTemplate>(message: EmailMessage<T>): RenderedEmail {
  const params = EMAIL_TEMPLATE_PARAMS[message.template].parse(message.params) as Params<T>;
  const keys = EMAIL_TEMPLATES[message.template];
  const messages = EMAIL_MESSAGES_TH as unknown as Record<string, (p: Params<T>) => string>;
  const subject = messages[keys.subjectKey];
  const body = messages[keys.bodyKey];
  if (subject === undefined || body === undefined) {
    throw new Error(`Email template ${message.template} has no Thai text`);
  }
  return { subject: subject(params), text: body(params) };
}

export interface SentEmail {
  to: string;
  template: EmailTemplate;
  idempotencyKey: string;
  subject: string;
  text: string;
}

/** Records rendered messages instead of sending them (tests, local runs; refused in production). */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: SentEmail[] = [];
  /** Make the next send throw. */
  failNext = false;

  send<T extends EmailTemplate>(message: EmailMessage<T>): Promise<{ messageId: string }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('email provider unavailable'));
    }
    const rendered = renderEmail(message);
    // Providers dedupe on the idempotency key; so does the fake.
    if (!this.sent.some((m) => m.idempotencyKey === message.idempotencyKey)) {
      this.sent.push({
        to: message.to,
        template: message.template,
        idempotencyKey: message.idempotencyKey,
        ...rendered,
      });
    }
    return Promise.resolve({ messageId: `fake-${randomUUID()}` });
  }
}

/**
 * The SESv2 `SendEmail` input the provider builds (the shape of `SendEmailCommandInput` of
 * @aws-sdk/client-sesv2). No ConfigurationSetName: the identity's default configuration set
 * applies (infra).
 */
export interface SesV2SendEmailInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  Content: {
    Simple: {
      Subject: { Data: string; Charset: 'UTF-8' };
      Body: { Text: { Data: string; Charset: 'UTF-8' } };
    };
  };
}

/** Sends one SESv2 SendEmail request; returns its MessageId. */
export type SesV2SendEmail = (input: SesV2SendEmailInput) => Promise<{ MessageId?: string }>;

/** `"Name" <address>` with the display name RFC 2047-encoded (Thai names are allowed). */
export function fromHeader(from: EmailSender): string {
  const encoded = `=?UTF-8?B?${Buffer.from(from.name, 'utf8').toString('base64')}?=`;
  return `${encoded} <${from.address}>`;
}

/** The SESv2 SendEmail input of a message (rendered Thai text, plain text body). */
export function sesV2Input<T extends EmailTemplate>(
  config: SendingEmailConfig,
  message: EmailMessage<T>,
): SesV2SendEmailInput {
  const rendered = renderEmail(message);
  return {
    FromEmailAddress: fromHeader(config.from),
    Destination: { ToAddresses: [message.to] },
    Content: {
      Simple: {
        Subject: { Data: rendered.subject, Charset: 'UTF-8' },
        Body: { Text: { Data: rendered.text, Charset: 'UTF-8' } },
      },
    },
  };
}

/**
 * Amazon SES (v2 SendEmail). `send` is the SESv2 client call; main.ts wires it once the api
 * depends on @aws-sdk/client-sesv2 (not installed yet: a root/lockfile change). Without it every
 * send fails, which the receipt path tolerates (the receipt stays unsent, `receipt_sent_at` null,
 * for a later retry).
 */
export class SesEmailProvider implements EmailProvider {
  constructor(
    private readonly config: SendingEmailConfig,
    private readonly sendEmail: SesV2SendEmail | null = null,
  ) {}

  async send<T extends EmailTemplate>(message: EmailMessage<T>): Promise<{ messageId: string }> {
    if (this.sendEmail === null) throw new Error('SES email client is not configured');
    const result = await this.sendEmail(sesV2Input(this.config, message));
    return { messageId: result.MessageId ?? '' };
  }
}

/**
 * The provider EMAIL_PROVIDER selects. `off`: OffEmailProvider, which drops every message and
 * passes `log` only the template (DroppedEmailLogEntry: never the recipient, parameters, body or
 * idempotency key). main.ts and createApiApp pass the app logger.
 */
export function createEmailProvider(
  config: EmailConfig,
  sesSend: SesV2SendEmail | null = null,
  log: (entry: DroppedEmailLogEntry) => void = () => undefined,
): EmailProvider {
  switch (config.provider) {
    case 'ses':
      return new SesEmailProvider(config, sesSend);
    case 'fake':
      return new FakeEmailProvider();
    case 'off':
      return new OffEmailProvider(log);
  }
}
