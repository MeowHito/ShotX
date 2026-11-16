import { type AccountEmail, escapeHtml } from '../auth/account-email';

// The Thai emails of ADR 0026 (Free sign-up and package orders), in the style of
// passwordResetEmail: plain text plus a small HTML version, one button. Nothing here logs a
// recipient, a link or a body. The amounts shown are a summary, not a tax invoice.

/** Web pages the emails link to (apps/web routes). */
export const WEB_SIGN_IN_PATH = '/login';
export const WEB_FORGOT_PASSWORD_PATH = '/forgot-password';
export const WEB_STUDIO_PATH = '/studio';

const greetingOf = (name: string | null) =>
  name !== null && name.trim() !== '' ? `สวัสดีคุณ ${name}` : 'สวัสดี';

const BUTTON =
  'display:inline-block;padding:12px 20px;border-radius:10px;background:#111;color:#fff;text-decoration:none';
const SMALL = 'font-size:13px;color:#555';

/** Bangkok date and time in Thai, e.g. `23 พฤศจิกายน 2569 12:00`. */
export function thaiDateTime(at: Date): string {
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(at);
}

/** Satang as Thai baht, e.g. `640.93 บาท`. */
export function thaiBaht(satang: number): string {
  const baht = new Intl.NumberFormat('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(satang / 100);
  return `${baht} บาท`;
}

function render(input: {
  to: string;
  subject: string;
  greeting: string;
  intro: string[];
  button: { label: string; href: string } | null;
  links?: { label: string; href: string }[];
  notes: string[];
}): AccountEmail {
  const text = [
    input.greeting,
    ...input.intro,
    ...(input.button === null ? [] : [`${input.button.label}: ${input.button.href}`]),
    ...(input.links ?? []).map((l) => `${l.label}: ${l.href}`),
    ...input.notes,
  ];
  const html = [
    '<div style="font-family:sans-serif;font-size:16px;line-height:1.6;color:#111">',
    `<p>${escapeHtml(input.greeting)}</p>`,
    ...input.intro.map((line) => `<p>${escapeHtml(line)}</p>`),
    ...(input.button === null
      ? []
      : [
          `<p><a href="${escapeHtml(input.button.href)}" style="${BUTTON}">${escapeHtml(input.button.label)}</a></p>`,
          `<p style="${SMALL}">หรือเปิดลิงก์นี้: <a href="${escapeHtml(input.button.href)}">${escapeHtml(input.button.href)}</a></p>`,
        ]),
    ...(input.links ?? []).map(
      (l) =>
        `<p>${escapeHtml(l.label)}: <a href="${escapeHtml(l.href)}">${escapeHtml(l.href)}</a></p>`,
    ),
    input.notes.length === 0
      ? ''
      : `<p style="${SMALL}">${input.notes.map(escapeHtml).join('<br>')}</p>`,
    '</div>',
  ].join('');
  return { to: input.to, subject: input.subject, text: text.join('\n\n'), html };
}

/**
 * Free sign-up step 1: the confirmation link (`/signup/confirm#token=…`, valid `ttlHours`). No
 * name: whoever asked typed it unverified.
 */
export function signupLinkEmail(input: {
  to: string;
  link: string;
  ttlHours: number;
}): AccountEmail {
  return render({
    to: input.to,
    subject: 'ยืนยันอีเมลเพื่อเริ่มใช้ Snap ฟรี',
    // Never the typed name: it is unverified (an abuser could put a message in it).
    greeting: 'สวัสดี',
    intro: [
      'ขอบคุณที่สมัครแพ็กเกจ Free ของ Snap กดปุ่มด้านล่างเพื่อยืนยันอีเมลและตั้งรหัสผ่าน แล้วเริ่มใช้งานได้ทันที',
    ],
    button: { label: 'ยืนยันอีเมลและตั้งรหัสผ่าน', href: input.link },
    notes: [
      `ลิงก์นี้ใช้ได้ครั้งเดียว ภายใน ${input.ttlHours} ชั่วโมง`,
      'ถ้าคุณไม่ได้สมัคร ไม่ต้องทำอะไร จะไม่มีบัญชีถูกสร้างขึ้น',
    ],
  });
}

/** Free sign-up for an email that already has an account: sign in, or reset the password. */
export function accountExistsEmail(input: {
  to: string;
  signInUrl: string;
  forgotPasswordUrl: string;
}): AccountEmail {
  return render({
    to: input.to,
    subject: 'คุณมีบัญชี Snap อยู่แล้ว',
    greeting: 'สวัสดี',
    intro: [
      'มีคำขอสมัคร Snap ด้วยอีเมลนี้ แต่อีเมลนี้มีบัญชีอยู่แล้ว จึงไม่ได้สร้างบัญชีใหม่',
      'เข้าสู่ระบบด้วยบัญชีเดิมได้เลย ถ้าจำรหัสผ่านไม่ได้ ตั้งรหัสผ่านใหม่ได้จากลิงก์ "ลืมรหัสผ่าน"',
    ],
    button: { label: 'เข้าสู่ระบบ', href: input.signInUrl },
    links: [{ label: 'ลืมรหัสผ่าน', href: input.forgotPasswordUrl }],
    notes: ['ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร'],
  });
}

/** The package summary lines of the paid-order emails (not a tax invoice). */
function packageLines(input: { packageName: string; expiresAt: Date; totalSatang: number }) {
  return [
    `แพ็กเกจ: ${input.packageName}`,
    `ใช้งานได้ถึง: ${thaiDateTime(input.expiresAt)}`,
    `ยอดชำระ (รวม VAT): ${thaiBaht(input.totalSatang)}`,
  ];
}

/** A paid order created the account: set the password (an ADR 0025 reset link, `ttlDays`). */
export function setPasswordEmail(input: {
  to: string;
  name: string | null;
  link: string;
  ttlDays: number;
  packageName: string;
  expiresAt: Date;
  totalSatang: number;
}): AccountEmail {
  return render({
    to: input.to,
    subject: 'ชำระเงินสำเร็จ ตั้งรหัสผ่านเพื่อเริ่มใช้ Snap',
    greeting: greetingOf(input.name),
    intro: [
      'ขอบคุณที่ชำระเงิน บัญชี Snap ของคุณพร้อมแล้ว กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านและเข้าใช้งาน',
      ...packageLines(input),
    ],
    button: { label: 'ตั้งรหัสผ่าน', href: input.link },
    notes: [
      `ลิงก์นี้ใช้ได้ครั้งเดียว ภายใน ${input.ttlDays} วัน ถ้าลิงก์หมดอายุ ใช้ "ลืมรหัสผ่าน" ที่หน้าเข้าสู่ระบบ`,
      'อีเมลนี้เป็นการยืนยันการชำระเงิน ไม่ใช่ใบกำกับภาษี',
    ],
  });
}

/** A paid order for an existing account: the package was added. */
export function packageAddedEmail(input: {
  to: string;
  name: string | null;
  studioUrl: string;
  packageName: string;
  expiresAt: Date;
  totalSatang: number;
}): AccountEmail {
  return render({
    to: input.to,
    subject: 'เพิ่มแพ็กเกจแล้ว - Snap',
    greeting: greetingOf(input.name),
    intro: ['ขอบคุณที่ชำระเงิน เราเพิ่มแพ็กเกจให้บัญชี Snap ของคุณแล้ว', ...packageLines(input)],
    button: { label: 'ไปที่สตูดิโอ', href: input.studioUrl },
    notes: ['อีเมลนี้เป็นการยืนยันการชำระเงิน ไม่ใช่ใบกำกับภาษี'],
  });
}
