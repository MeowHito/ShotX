import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Admin TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA1: the algorithm every authenticator app
// supports), the secret's AES-256-GCM encryption at rest (admin_credentials) and the otpauth://
// URI the operator CLI shows once. Node's crypto only: the algorithms are a few lines each and a
// dependency would add supply-chain risk to the admin sign-in.

/** 160-bit secrets (RFC 4226 section 4 recommends at least 160 bits). */
export const TOTP_SECRET_BYTES = 20;
/** AES-GCM nonce and tag sizes (admin_credentials CHECK: 12-byte nonce). */
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (what otpauth:// URIs carry). */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes RFC 4648 base32 (case-insensitive, padding and spaces ignored). Throws on bad input. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new RangeError('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): HMAC-SHA1 of the 8-byte counter, dynamic truncation, `digits` digits. */
export function hotp(secret: Uint8Array, counter: number, digits: 6 | 8): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP time step of `nowMs` (RFC 6238: T = floor(unix seconds / period)). */
export function totpStep(nowMs: number, periodSeconds: number): number {
  return Math.floor(nowMs / 1000 / periodSeconds);
}

export interface TotpCheck {
  nowMs: number;
  periodSeconds: number;
  digits: 6 | 8;
  /** Steps accepted before and after the current one. */
  window: number;
  /** admin_credentials.totp_last_used_step: this step and earlier ones are replays. */
  lastUsedStep: number | null;
}

/**
 * The time step `code` is valid for, or null. Only steps within the window and after
 * `lastUsedStep` count (replay protection; the caller must still record the step atomically).
 * Every candidate is compared in constant time, and all of them are computed.
 */
export function matchTotp(secret: Uint8Array, code: string, check: TotpCheck): number | null {
  if (code.length !== check.digits || !/^\d+$/.test(code)) return null;
  const current = totpStep(check.nowMs, check.periodSeconds);
  const presented = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let step = current - check.window; step <= current + check.window; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step, check.digits), 'utf8');
    const equal = timingSafeEqual(expected, presented);
    const fresh = check.lastUsedStep === null || step > check.lastUsedStep;
    if (equal && fresh && matched === null) matched = step;
  }
  return matched;
}

/** A new random TOTP secret. */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

export interface EncryptedTotpSecret {
  /** Ciphertext followed by the 16-byte GCM tag (admin_credentials.totp_secret_encrypted). */
  ciphertext: Buffer;
  /** 12-byte nonce (admin_credentials.totp_secret_nonce). */
  nonce: Buffer;
}

/**
 * AES-256-GCM with a fresh random nonce and the user id as additional authenticated data, so a
 * row's secret can't be moved to another admin.
 */
export function encryptTotpSecret(
  key: Uint8Array,
  userId: string,
  secret: Uint8Array,
): EncryptedTotpSecret {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/** Decrypts encryptTotpSecret's output. Throws when the key, user id or data don't match. */
export function decryptTotpSecret(
  key: Uint8Array,
  userId: string,
  encrypted: EncryptedTotpSecret,
): Buffer {
  const { ciphertext, nonce } = encrypted;
  if (nonce.length !== GCM_NONCE_BYTES || ciphertext.length <= GCM_TAG_BYTES) {
    throw new RangeError('Invalid encrypted TOTP secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - GCM_TAG_BYTES)),
    decipher.final(),
  ]);
}

/**
 * The enrolment URI for authenticator apps (Google Authenticator's Key Uri Format):
 * `otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=..&period=..`.
 */
export function otpauthUri(input: {
  issuer: string;
  account: string;
  secret: Uint8Array;
  digits: 6 | 8;
  periodSeconds: number;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(input.digits),
    period: String(input.periodSeconds),
  });
  return `otpauth://totp/${label}?${query.toString().replace(/\+/g, '%20')}`;
}
