import { z } from 'zod';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Random bits in a share token (spec: 128). */
export const SHARE_TOKEN_BITS = 128;

/** Characters of a share token: 128 bits need 22 base62 digits (62^21 < 2^128 < 62^22). */
export const SHARE_TOKEN_LENGTH = 22;

const TOKEN = new RegExp(`^[0-9A-Za-z]{${SHARE_TOKEN_LENGTH}}$`);

/**
 * A share token as it appears in `/s/{token}`: exactly 22 base62 characters. The database allows
 * 16–64 (`shares_token_base62`) so the length can change without a migration, but the API only
 * issues and accepts this format. A token that doesn't match is NOT_FOUND, never
 * VALIDATION_FAILED, so the response doesn't tell a malformed token from an unknown one.
 */
export const shareTokenSchema = z.string().regex(TOKEN, { error: 'must be a share token' });

export function isShareToken(value: string): boolean {
  return TOKEN.test(value);
}

/** Fills a buffer with cryptographically secure random bytes. */
export type RandomBytes = (length: number) => Uint8Array;

/** Web Crypto's CSPRNG (Node 20+, browsers). */
export const cryptoRandomBytes: RandomBytes = (length) =>
  globalThis.crypto.getRandomValues(new Uint8Array(length));

/** 16 bytes as exactly 22 base62 digits, most significant first. Unbiased: a base conversion. */
export function base62Of128Bits(bytes: Uint8Array): string {
  if (bytes.length !== SHARE_TOKEN_BITS / 8) {
    throw new RangeError(`Expected ${SHARE_TOKEN_BITS / 8} bytes, got ${bytes.length}`);
  }
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < SHARE_TOKEN_LENGTH; i++) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

/**
 * A new 128-bit opaque token in base62 (22 characters) from a CSPRNG. Used for share tokens and
 * for the opaque values of the unlock and viewer-session cookies. `randomBytes` is for tests only.
 */
export function generateOpaqueToken(randomBytes: RandomBytes = cryptoRandomBytes): string {
  return base62Of128Bits(randomBytes(SHARE_TOKEN_BITS / 8));
}

/** A new share token. Insert it; on the (astronomically unlikely) unique violation, retry. */
export function generateShareToken(randomBytes: RandomBytes = cryptoRandomBytes): string {
  return generateOpaqueToken(randomBytes);
}

/** Path of the share page: `/{token}` (ADR 0015; old `/s/{token}` links redirect there). */
export function sharePagePath(token: string): string {
  if (!isShareToken(token)) throw new RangeError('Not a share token');
  return `/${token}`;
}

/** Absolute share link, e.g. `https://example.com/{token}`. `publicBaseUrl` is AppConfig's. */
export function shareUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${sharePagePath(token)}`;
}
