/**
 * The parts of an `otpauth://totp/...` URI an admin needs to type into an authenticator app when
 * scanning the QR code isn't possible. Parsed in the browser only; the URI (and so the secret) is
 * never stored, logged or sent anywhere by the admin app.
 */
export interface OtpauthParts {
  /** Base32 secret, upper-case, without padding. */
  secret: string;
  issuer: string | null;
  account: string | null;
  digits: number;
  periodSeconds: number;
  algorithm: string;
}

const BASE32 = /^[A-Z2-7]+$/;

export function parseOtpauthUri(uri: string): OtpauthParts | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'otpauth:') return null;
  // `otpauth://totp/Label`: WHATWG URL puts `totp` in host for special-less schemes, or in the
  // pathname as `//totp/Label`, depending on the runtime.
  const rest = `${url.host}${url.pathname}`.replace(/^\/\//, '');
  if (!rest.toLowerCase().startsWith('totp/')) return null;
  const secret = (url.searchParams.get('secret') ?? '').toUpperCase().replace(/=+$/, '');
  if (secret === '' || !BASE32.test(secret)) return null;
  let label: string;
  try {
    label = decodeURIComponent(rest.slice('totp/'.length));
  } catch {
    label = '';
  }
  const colon = label.indexOf(':');
  const labelIssuer = colon > 0 ? label.slice(0, colon).trim() : null;
  const account = (colon >= 0 ? label.slice(colon + 1) : label).trim() || null;
  const digits = Number(url.searchParams.get('digits') ?? '6');
  const period = Number(url.searchParams.get('period') ?? '30');
  return {
    secret,
    issuer: url.searchParams.get('issuer') || labelIssuer,
    account,
    digits: digits === 8 ? 8 : 6,
    periodSeconds: Number.isInteger(period) && period > 0 ? period : 30,
    algorithm: (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase(),
  };
}

/** The secret in groups of four for reading and typing (`JBSW Y3DP EHPK 3PXP`). */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}
