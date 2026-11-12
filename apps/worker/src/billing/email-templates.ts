import {
  BILLING_TIME_ZONE,
  EMAIL_TEMPLATE_PARAMS,
  EMAIL_TEMPLATES,
  type EmailMessage,
  type EmailTemplate,
  type EmailTemplateParams,
  type PaymentMethod,
} from '@shotx/shared';

/**
 * Thai text of the lifecycle and receipt emails (EMAIL_TEMPLATES in @shotx/shared names the i18n
 * keys; the text lives here and in the api). Amounts are satang rendered as THB with 2 decimals,
 * times are rendered in Asia/Bangkok. Parameters never carry card data or biometrics.
 */

const thb = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('th-TH', {
  timeZone: BILLING_TIME_ZONE,
  dateStyle: 'long',
  timeStyle: 'short',
});

/** `14,900` satang → `149.00 บาท`. */
export function formatBaht(satang: number): string {
  return `${thb.format(satang / 100)} บาท`;
}

/** An ISO instant on the Bangkok wall clock, e.g. `1 ธันวาคม 2569 00:00 น.`. */
export function formatBangkok(iso: string): string {
  return `${dateTime.format(new Date(iso))} น.`;
}

const METHOD_TH: Record<PaymentMethod, string> = {
  promptpay: 'พร้อมเพย์',
  card: 'บัตรเครดิต/เดบิต',
};

const SIGNATURE = '\n\nขอบคุณที่ใช้บริการ\nทีมงาน Snap';

type Text<T extends EmailTemplate> = (params: EmailTemplateParams<T>) => string;

interface TemplateText<T extends EmailTemplate> {
  subject: Text<T>;
  body: Text<T>;
}

const TEXT: { [T in EmailTemplate]: TemplateText<T> } = {
  renewal_reminder: {
    subject: (p) => `แพ็กเกจ ${p.planName} จะครบกำหนดในอีก ${p.daysBefore} วัน`,
    body: (p) =>
      [
        `แพ็กเกจ ${p.planName} ของคุณจะครบกำหนดในวันที่ ${formatBangkok(p.periodEnd)}`,
        p.autoRenew && p.renewalAmountSatang !== null
          ? `ระบบจะต่ออายุอัตโนมัติและตัดเงิน ${formatBaht(p.renewalAmountSatang)} จากบัตรที่บันทึกไว้ หากต้องการยกเลิกการต่ออายุอัตโนมัติ ทำได้ที่หน้าการชำระเงิน`
          : 'กรุณาต่ออายุก่อนวันครบกำหนด เพื่อให้อัปโหลดไฟล์ได้ต่อเนื่อง หลังวันครบกำหนดระบบจะงดการอัปโหลด แต่ลิงก์แชร์และการดาวน์โหลดยังใช้งานได้ช่วงระยะผ่อนผัน',
        `จัดการแพ็กเกจ: ${p.billingUrl}`,
      ].join('\n\n') + SIGNATURE,
  },
  payment_receipt: {
    subject: (p) => `ใบเสร็จรับเงิน Snap แพ็กเกจ ${p.planName}`,
    body: (p) =>
      [
        'เราได้รับชำระเงินของคุณเรียบร้อยแล้ว',
        [
          `เลขที่การชำระเงิน: ${p.paymentId}`,
          `แพ็กเกจ: ${p.planName}`,
          `ช่องทาง: ${METHOD_TH[p.method]}`,
          `ชำระเมื่อ: ${formatBangkok(p.paidAt)}`,
          `ยอดก่อนภาษี: ${formatBaht(p.netSatang)}`,
          `ภาษีมูลค่าเพิ่ม: ${formatBaht(p.vatSatang)}`,
          `ยอดรวม: ${formatBaht(p.totalSatang)}`,
          `ใช้งานได้ถึง: ${formatBangkok(p.periodEnd)}`,
        ].join('\n'),
        'เอกสารนี้เป็นใบเสร็จรับเงิน ไม่ใช่ใบกำกับภาษีเต็มรูป',
        `ประวัติการชำระเงิน: ${p.billingUrl}`,
      ].join('\n\n') + SIGNATURE,
  },
  grace_started: {
    subject: () => 'แพ็กเกจของคุณครบกำหนดแล้ว ระบบงดการอัปโหลดชั่วคราว',
    body: (p) =>
      [
        'แพ็กเกจของคุณครบกำหนดแล้ว ตอนนี้ไม่สามารถอัปโหลดไฟล์ใหม่ได้',
        `ลิงก์แชร์และการดาวน์โหลดยังใช้งานได้ถึงวันที่ ${formatBangkok(p.graceEndsAt)} หลังจากนั้นลิงก์แชร์จะหมดอายุ`,
        `ต่ออายุได้ที่: ${p.billingUrl}`,
      ].join('\n\n') + SIGNATURE,
  },
  subscription_expired: {
    subject: () => 'บัญชี Snap ของคุณหมดอายุแล้ว',
    body: (p) =>
      [
        'บัญชีของคุณหมดอายุแล้ว ลิงก์แชร์ทั้งหมดจะแสดงข้อความ "ลิงก์นี้หมดอายุ"',
        'คุณยังเข้าสู่ระบบ ต่ออายุ และดาวน์โหลดไฟล์ของคุณเองได้',
        `หากไม่ต่ออายุ ไฟล์ทั้งหมดและข้อมูลใบหน้าที่จัดทำดัชนีไว้จะถูกลบถาวรในวันที่ ${formatBangkok(p.purgeAt)}`,
        `ต่ออายุได้ที่: ${p.billingUrl}`,
      ].join('\n\n') + SIGNATURE,
  },
  purge_warning: {
    subject: (p) => `ไฟล์ของคุณจะถูกลบถาวรในวันที่ ${formatBangkok(p.purgeAt)}`,
    body: (p) =>
      [
        `ไฟล์ทั้งหมด โฟลเดอร์ ลิงก์แชร์ และข้อมูลใบหน้าในบัญชีของคุณจะถูกลบถาวรในวันที่ ${formatBangkok(p.purgeAt)} และไม่สามารถกู้คืนได้`,
        'หากต้องการเก็บไฟล์ไว้ กรุณาดาวน์โหลดหรือต่ออายุก่อนวันดังกล่าว ประวัติการชำระเงินจะยังเก็บไว้ตามกฎหมาย',
        `ต่ออายุได้ที่: ${p.billingUrl}`,
      ].join('\n\n') + SIGNATURE,
  },
};

/**
 * The Thai strings by i18n key (EMAIL_TEMPLATES[t].subjectKey / bodyKey), so a test can check that
 * every template has both.
 */
export const EMAIL_MESSAGES_TH: Readonly<Record<string, Text<EmailTemplate>>> = Object.fromEntries(
  (Object.keys(EMAIL_TEMPLATES) as EmailTemplate[]).flatMap((t) => [
    [EMAIL_TEMPLATES[t].subjectKey, TEXT[t].subject as Text<EmailTemplate>],
    [EMAIL_TEMPLATES[t].bodyKey, TEXT[t].body as Text<EmailTemplate>],
  ]),
);

export interface RenderedEmail {
  subject: string;
  text: string;
}

/** Validates the parameters (strict) and renders the Thai subject and plain-text body. */
export function renderEmail(message: EmailMessage): RenderedEmail {
  const keys = EMAIL_TEMPLATES[message.template];
  const params = EMAIL_TEMPLATE_PARAMS[message.template].parse(message.params);
  const subject = EMAIL_MESSAGES_TH[keys.subjectKey];
  const body = EMAIL_MESSAGES_TH[keys.bodyKey];
  if (subject === undefined || body === undefined) {
    throw new Error(`Email template ${message.template} has no Thai text`);
  }
  return { subject: subject(params), text: body(params) };
}
