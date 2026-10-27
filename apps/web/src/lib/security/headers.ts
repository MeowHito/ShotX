/**
 * Security headers of every page and route handler (set in src/proxy.ts).
 *
 * - Scripts: only Next's own, tagged with the per-request nonce ('strict-dynamic').
 * - Images and video: the site ('self', plus PUBLIC_BASE_URL for setups where the app runs on
 *   another origin) and the media origins: with MEDIA_URL_SIGNER=s3-presign signed URLs point at
 *   the storage endpoint (R2 on the VPS, LocalStack locally); with `cloudfront` they are
 *   same-origin `/media/*` and nothing is added (loadMediaBrowserOrigins).
 * - connect-src: the BFF ('self'), the upload origin(s) the browser PUTs parts to, and the media
 *   origins (the iOS multi-save fetches signed downloads for navigator.share).
 * - form-action: 'self', plus the Cognito domain with AUTH_PROVIDER=cognito (the logout form
 *   redirects there). With API-issued tokens nothing else: LINE and Google are reached through
 *   links to /auth/login (navigations), never as a form's redirect target (formActionOrigins).
 * - style-src keeps 'unsafe-inline': Radix and TanStack Virtual set inline styles at run time.
 * - Share pages (`allowWasm`) add 'wasm-unsafe-eval' for MediaPipe's face detector. Its loader
 *   script is inserted by our own (nonced) code, which 'strict-dynamic' allows; its wasm and model
 *   are fetched from same-origin paths (connect-src 'self'); no CDN is allowed anywhere.
 * - Share pages with CAPTCHA_PROVIDER=turnstile (`captcha`) add the Turnstile origin to
 *   `script-src` and `frame-src`: the one exception to "no CDN" (ADR 0008 section 7). The
 *   script is inserted by our nonced code after a rate-limit hit ('strict-dynamic' trusts it; the
 *   host entry is for browsers without 'strict-dynamic'), and the widget is its iframe. Without
 *   it there is no `frame-src` (frames fall back to `default-src 'self'`, as before).
 */

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Served over https: ask browsers to upgrade any http subresource. */
  https: boolean;
  publicBaseUrl?: string;
  /** Origins the browser PUTs upload parts to (MediaBrowserOrigins.upload). */
  uploadOrigins: readonly string[];
  /** Origins of signed media URLs other than the site itself (MediaBrowserOrigins.media). */
  mediaOrigins?: readonly string[];
  /** Origins a form submission may redirect to besides 'self' (formActionOrigins). */
  formActionOrigins?: readonly string[];
  /** Allow compiling WebAssembly (the share page's MediaPipe face detector). */
  allowWasm?: boolean;
  /** captchaCspSources of the configured captcha (share pages only). */
  captcha?: {
    scriptSrc: readonly string[];
    frameSrc: readonly string[];
    connectSrc: readonly string[];
  };
}

export function buildCsp(options: CspOptions): string {
  const self = [
    "'self'",
    ...(options.publicBaseUrl ? [new URL(options.publicBaseUrl).origin] : []),
  ];
  const unique = (values: string[]) => [...new Set(values)].join(' ');
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': unique([
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      ...(options.captcha?.scriptSrc ?? []),
      ...(options.allowWasm ? ["'wasm-unsafe-eval'"] : []),
      ...(options.isDev ? ["'unsafe-eval'"] : []),
    ]),
    'style-src': "'self' 'unsafe-inline'",
    'img-src': unique([...self, ...(options.mediaOrigins ?? []), 'blob:', 'data:']),
    'media-src': unique([...self, ...(options.mediaOrigins ?? []), 'blob:']),
    'font-src': "'self'",
    'connect-src': unique([
      ...self,
      ...options.uploadOrigins,
      ...(options.mediaOrigins ?? []),
      ...(options.captcha?.connectSrc ?? []),
      ...(options.isDev ? ['ws:', 'wss:'] : []),
    ]),
    ...((options.captcha?.frameSrc.length ?? 0) > 0
      ? { 'frame-src': unique(["'self'", ...(options.captcha?.frameSrc ?? [])]) }
      : {}),
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
