import type { CookieSpec } from '@shotx/shared';
import type { Request, Response } from 'express';

/**
 * Cookie values of the request. Only names the API sets are read, and only values made of
 * cookie-safe characters; anything else is ignored (never an error, never logged).
 */
export function readCookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.cookie;
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    // The first occurrence wins: browsers send the most specific path first.
    if (!out.has(name) && /^[A-Za-z0-9_-]{1,64}$/.test(value)) out.set(name, value);
  }
  return out;
}

function serialize(spec: CookieSpec, value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${spec.name}=${value}`,
    `Path=${spec.path}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    `SameSite=${spec.sameSite}`,
  ];
  if (spec.secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** Adds a Set-Cookie header (the value must be cookie-safe: tokens and uuids only). */
export function setCookie(res: Response, spec: CookieSpec, value: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new RangeError('Cookie value is not cookie-safe');
  res.append('Set-Cookie', serialize(spec, value, spec.maxAgeSeconds));
}

/** Deletes a cookie (same name and path, Max-Age=0). */
export function clearCookie(res: Response, spec: CookieSpec): void {
  res.append('Set-Cookie', serialize(spec, '', 0));
}
