/**
 * Security headers of every page and route handler (set in src/proxy.ts).
 *
 * - Scripts: only Next's own, tagged with the per-request nonce ('strict-dynamic').
 * - Images and video: same origin. Media is served by CloudFront under `/media/*` on the main
 *   domain, so signed thumbnail and preview URLs are 'self'; PUBLIC_BASE_URL is listed too for
 *   setups where the app runs on another origin (local development).
 * - connect-src: the BFF ('self') and the S3 upload origin(s) the browser PUTs parts to.
 * - form-action: the logout form redirects to the Cognito domain.
 * - style-src keeps 'unsafe-inline': Radix and TanStack Virtual set inline styles at run time.
 */

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Served over https: ask browsers to upgrade any http subresource. */
  https: boolean;
  publicBaseUrl?: string;
  uploadOrigins: readonly string[];
  cognitoDomain?: string;
}

export function buildCsp(options: CspOptions): string {
  const self = [
    "'self'",
    ...(options.publicBaseUrl ? [new URL(options.publicBaseUrl).origin] : []),
  ];
  const unique = (values: string[]) => [...new Set(values)].join(' ');
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': `'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.isDev ? " 'unsafe-eval'" : ''}`,
    'style-src': "'self' 'unsafe-inline'",
    'img-src': unique([...self, 'blob:', 'data:']),
    'media-src': unique([...self, 'blob:']),
    'font-src': "'self'",
    'connect-src': unique([
      ...self,
      ...options.uploadOrigins,
      ...(options.isDev ? ['ws:', 'wss:'] : []),
    ]),
    'form-action': unique([
      "'self'",
      ...(options.cognitoDomain ? [new URL(options.cognitoDomain).origin] : []),
    ]),
    'frame-ancestors': "'none'",
    'base-uri': "'self'",
    'object-src': "'none'",
    'worker-src': "'self' blob:",
    'manifest-src': "'self'",
  };
  const parts = Object.entries(directives).map(([name, value]) => `${name} ${value}`);
  if (options.https) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

export function securityHeaders(csp: string, https: boolean): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // The share page's face scan (Phase 3) needs the camera on this origin only.
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}
