/**
 * Security headers of every page and route handler (set in src/proxy.ts).
 *
 * - Scripts: only Next's own, tagged with the per-request nonce ('strict-dynamic').
 * - Images and video: same origin. Media is served by CloudFront under `/media/*` on the main
 *   domain, so signed thumbnail and preview URLs are 'self'; PUBLIC_BASE_URL is listed too for
 *   setups where the app runs on another origin (local development).
 * - connect-src: the BFF ('self') and the S3 upload origin(s) the browser PUTs parts to.
 * - form-action: 'self', plus the Cognito domain with AUTH_PROVIDER=cognito (the logout form
 *   redirects there). With API-issued tokens nothing else: LINE and Google are reached through
 *   links to /auth/login (navigations), never as a form's redirect target (formActionOrigins).
 * - style-src keeps 'unsafe-inline': Radix and TanStack Virtual set inline styles at run time.
 * - Share pages (`allowWasm`) add 'wasm-unsafe-eval' for MediaPipe's face detector. Its loader
 *   script is inserted by our own (nonced) code, which 'strict-dynamic' allows; its wasm and model
 *   are fetched from same-origin paths (connect-src 'self'); no CDN is allowed anywhere.
 */

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Served over https: ask browsers to upgrade any http subresource. */
  https: boolean;
  publicBaseUrl?: string;
  uploadOrigins: readonly string[];
  /** Origins of signed media URLs other than the site itself (LocalStack in development). */
  mediaOrigins?: readonly string[];
  /** Origins a form submission may redirect to besides 'self' (formActionOrigins). */
  formActionOrigins?: readonly string[];
  /** Allow compiling WebAssembly (the share page's MediaPipe face detector). */
  allowWasm?: boolean;
}

export function buildCsp(options: CspOptions): string {
  const self = [
    "'self'",
    ...(options.publicBaseUrl ? [new URL(options.publicBaseUrl).origin] : []),
  ];
  const unique = (values: string[]) => [...new Set(values)].join(' ');
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': `'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.allowWasm ? " 'wasm-unsafe-eval'" : ''}${options.isDev ? " 'unsafe-eval'" : ''}`,
    'style-src': "'self' 'unsafe-inline'",
    'img-src': unique([...self, ...(options.mediaOrigins ?? []), 'blob:', 'data:']),
    'media-src': unique([...self, ...(options.mediaOrigins ?? []), 'blob:']),
    'font-src': "'self'",
    'connect-src': unique([
      ...self,
      ...options.uploadOrigins,
      ...(options.isDev ? ['ws:', 'wss:'] : []),
    ]),
    'form-action': unique(["'self'", ...(options.formActionOrigins ?? [])]),
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
