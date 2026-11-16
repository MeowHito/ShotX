import type { AccountEmailConfig, AccountEmailFrom } from '@shotx/shared';
import { createTransport } from 'nodemailer';

/**
 * Emails about a person's own account (ADR 0025), separate from the billing EmailProvider: the
 * photographer password-reset link, and (ADR 0026, packages/package-emails) the sign-up and
 * package emails. Plain text and a small HTML version, Thai only.
 * Nothing here logs a recipient, a link or a body.
 */

export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface AccountMailer {
  /** False with ACCOUNT_EMAIL_PROVIDER=off: features that need email are unavailable. */
  readonly available: boolean;
  /** Sends one message; throws on failure. */
  send(message: AccountEmail): Promise<void>;
}

/** ACCOUNT_EMAIL_PROVIDER=off. */
export class OffAccountMailer implements AccountMailer {
  readonly available = false;
  send(): Promise<void> {
    return Promise.reject(new Error('Account email is off'));
  }
}

/** ACCOUNT_EMAIL_PROVIDER=fake: records messages (tests, local runs; refused in production). */
export class FakeAccountMailer implements AccountMailer {
  readonly available = true;
  readonly sent: AccountEmail[] = [];
  /** Make the next send throw. */
  failNext = false;

  send(message: AccountEmail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('account email unavailable'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** `"Name" <address>` for nodemailer (it encodes a Thai name itself). */
function fromOf(from: AccountEmailFrom): { name: string; address: string } {
  return { name: from.name, address: from.address };
}

/** How long one SMTP send may take before it fails (connect, greet, send). */
const SMTP_TIMEOUT_MS = 15_000;

/** ACCOUNT_EMAIL_PROVIDER=smtp: one pooled nodemailer transport, TLS always required. */
export class SmtpAccountMailer implements AccountMailer {
  readonly available = true;
  private readonly transport;

  constructor(private readonly config: Extract<AccountEmailConfig, { provider: 'smtp' }>) {
    const { host, port, secure, user, password } = config.smtp;
    this.transport = createTransport({
      host,
      port,
      secure,
      requireTLS: !secure,
      auth: { user, pass: password },
      pool: true,
      maxConnections: 2,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      logger: false,
      debug: false,
    });
  }

  async send(message: AccountEmail): Promise<void> {
    await this.transport.sendMail({
      from: fromOf(this.config.from),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

export function createAccountMailer(config: AccountEmailConfig): AccountMailer {
  switch (config.provider) {
    case 'smtp':
      return new SmtpAccountMailer(config);
    case 'fake':
      return new FakeAccountMailer();
    case 'off':
      return new OffAccountMailer();
  }
}

/** HTML-escapes text for the account emails' HTML parts. */
export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The Thai password-reset email (link valid for `ttlMinutes`). */
export function passwordResetEmail(input: {
  to: string;
  name: string | null;
  link: string;
  ttlMinutes: number;
}): AccountEmail {
  const greeting =
    input.name !== null && input.name.trim() !== '' ? `สวัสดีคุณ ${input.name}` : 'สวัสดี';
  const lines = [
    greeting,
    'มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี Snap ของคุณ กดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่',
    input.link,
    `ลิงก์นี้ใช้ได้ครั้งเดียว ภายใน ${input.ttlMinutes} นาที`,
    'ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ',
  ];
  const href = escapeHtml(input.link);
  const html = [
    '<div style="font-family:sans-serif;font-size:16px;line-height:1.6;color:#111">',
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(lines[1] ?? '')}</p>`,
    `<p><a href="${href}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#111;color:#fff;text-decoration:none">ตั้งรหัสผ่านใหม่</a></p>`,
    `<p style="font-size:13px;color:#555">หรือเปิดลิงก์นี้: <a href="${href}">${href}</a></p>`,
    `<p style="font-size:13px;color:#555">${escapeHtml(lines[3] ?? '')}<br>${escapeHtml(lines[4] ?? '')}</p>`,
    '</div>',
  ].join('');
  return {
    to: input.to,
    subject: 'ตั้งรหัสผ่านใหม่ - Snap',
    text: lines.join('\n\n'),
    html,
  };
}
