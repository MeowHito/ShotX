/**
 * Security headers of every admin page and route handler (set in src/proxy.ts). Stricter than the
 * web app's: the admin app loads nothing from other origins (no media, uploads or captcha), is
 * never framed, and is never indexed.
 *
 * - Scripts: only Next's own, tagged with the per-request nonce ('strict-dynamic').
 * - Images: 'self' and data: (the TOTP QR code is inline SVG; nothing else is loaded).
 * - connect-src: 'self' (the BFF and the sign-in route handlers).
 * - style-src keeps 'unsafe-inline': Radix sets inline styles at run time.
 */

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Served over https: ask browsers to upgrade any http subresource. */
  https: boolean;
}

export function buildCsp(options: CspOptions): string {
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': [
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      ...(options.isDev ? ["'unsafe-eval'"] : []),
    ].join(' '),
    'style-src': "'self' 'unsafe-inline'",
    'img-src': "'self' data:",
    'font-src': "'self'",
    'connect-src': ["'self'", ...(options.isDev ? ['ws:', 'wss:'] : [])].join(' '),
    'form-action': "'self'",
    'frame-ancestors': "'none'",
    'frame-src': "'none'",
    'base-uri': "'self'",
    'object-src': "'none'",
    'worker-src': "'self'",
    'manifest-src': "'self'",
  };
  const parts = Object.entries(directives).map(([name, value]) => `${name} ${value}`);
  if (options.https) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** Admin pages are private: no search engine may index them or follow their links. */
export const ROBOTS_HEADER_VALUE = 'noindex, nofollow, noarchive, nosnippet';

export function securityHeaders(csp: string, https: boolean): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Robots-Tag': ROBOTS_HEADER_VALUE,
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}
