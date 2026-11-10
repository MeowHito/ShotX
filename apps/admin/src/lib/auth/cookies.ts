/** Minimal cookie parsing and serialization for route handlers that use plain Request/Response. */

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === null) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      // Ignore malformed values.
    }
  }
  return cookies;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
  path?: string;
}

/**
 * Every admin cookie is httpOnly and SameSite=Strict: the admin app is never entered from another
 * site with a session, and no admin cookie is ever readable by browser JS.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push('SameSite=Strict');
  return parts.join('; ');
}

export function expireCookie(name: string, secure: boolean, path = '/'): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure, path });
}
