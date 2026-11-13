import {
  type AuthClientConfig,
  type CaptchaCspSources,
  captchaCspSources,
  type AuthProviderName,
  type BillingOperatingMode,
  type CognitoPoolConfig,
  type Env,
  type MediaBrowserOrigins,
  type PasswordLengthPolicy,
  loadAppConfig,
  loadAuthClientConfig,
  loadCaptchaClientConfig,
  loadAuthProviderConfig,
  loadBffAuthConfig,
  loadBillingModeConfig,
  loadCognitoConfig,
  loadInternalApiConfig,
  loadMediaBrowserOrigins,
  loadPhotographerPasswordPolicy,
  loadUploadConfig,
  parseEnv,
  planCodeSchema,
} from '@shotx/shared';
import { z } from 'zod';
import type { ClientIpSource } from '../bff/client-ip';
import type { ClientFaceConfig, ClientShareConfig } from '../face/config';

/**
 * Server-side settings of the web app, read from the environment at request time (never at
 * build time: the Docker image is built once and configured per stage).
 */
export interface WebConfig {
  publicBaseUrl: string;
  apiInternalUrl: string;
  /**
   * AUTH_PROVIDER. `shotx` and `local`: the API issues tokens; `local` only on APP_STAGE=local
   * (loadAuthProviderConfig refuses it anywhere else). Web reads nothing else of that config.
   */
  authProvider: AuthProviderName;
  /** The users pool with AUTH_PROVIDER=cognito; null otherwise. */
  cognito: CognitoPoolConfig | null;
  /**
   * AUTH_BFF_KEY, sent on every server-side API call (secret: never log it). Always set with
   * `shotx`/`local`; null with `cognito` when unset, and then no client IP is passed either.
   */
  bffKey: string | null;
  /** Where the end user's address comes from (see ClientIpSource). */
  clientIpSource: ClientIpSource;
  /** Timeout of `/auth/*` calls and the API's refresh reuse grace (API-issued tokens only). */
  authClient: AuthClientConfig;
  /** `Secure` and `__Host-` cookies; off only on plain-http localhost. */
  secureCookies: boolean;
}

export function loadWebConfig(env: Env): WebConfig {
  const app = loadAppConfig(env);
  const { provider } = loadAuthProviderConfig(env);
  return {
    publicBaseUrl: app.publicBaseUrl,
    apiInternalUrl: loadInternalApiConfig(env).apiInternalUrl,
    authProvider: provider,
    cognito: provider === 'cognito' ? loadCognitoConfig(env, ['users']).users : null,
    bffKey: loadBffAuthConfig(env)?.key ?? null,
    // AWS (Cognito) sits behind CloudFront; the VPS behind the reverse proxy (ADR 0008).
    clientIpSource: provider === 'cognito' ? 'cloudfront-viewer-address' : 'x-forwarded-for',
    authClient: loadAuthClientConfig(env),
    secureCookies: app.publicBaseUrl.startsWith('https://'),
  };
}

let cached: WebConfig | undefined;

/** {@link loadWebConfig} of `process.env`, cached for the process. */
export function webConfig(): WebConfig {
  cached ??= loadWebConfig(process.env);
  return cached;
}

/** What the upload UI needs from the upload config (same env and defaults as the API). */
export interface ClientUploadConfig {
  maxBytes: { image: number; video: number };
  partBytes: number;
  partConcurrency: number;
}

export function clientUploadConfig(env: Env = process.env): ClientUploadConfig {
  const upload = loadUploadConfig(env);
  return {
    maxBytes: upload.maxBytes,
    partBytes: upload.partBytes,
    partConcurrency: upload.partConcurrency,
  };
}

/**
 * The storage origins the browser talks to, for the CSP (loadMediaBrowserOrigins; no storage
 * keys needed): `upload` (presigned part PUTs, `connect-src`) and `media` (signed view and
 * download URLs with MEDIA_URL_SIGNER=s3-presign, e.g. the R2 endpoint: `img-src`, `media-src`
 * and `connect-src`; empty with `cloudfront`, whose `/media` is same-origin).
 */
export function mediaBrowserOrigins(env: Env = process.env): MediaBrowserOrigins {
  return loadMediaBrowserOrigins(env);
}

let cachedMediaBrowserOrigins: MediaBrowserOrigins | undefined;

/** {@link mediaBrowserOrigins} of `process.env`, cached for the process (the proxy runs per request). */
export function processMediaBrowserOrigins(): MediaBrowserOrigins {
  cachedMediaBrowserOrigins ??= mediaBrowserOrigins(process.env);
  return cachedMediaBrowserOrigins;
}

/**
 * Origins the browser may be redirected to after submitting a form (CSP `form-action`): the
 * logout form ends at Cognito's /logout with AUTH_PROVIDER=cognito. With API-issued tokens every
 * form (logout, the development sign-in) redirects within the site, and LINE and Google are only
 * reached by following a link to /auth/login (a navigation, which `form-action` doesn't cover), so
 * nothing is added.
 */
export function formActionOrigins(env: Env = process.env): string[] {
  if (loadAuthProviderConfig(env).provider !== 'cognito') return [];
  const domain = env.COGNITO_DOMAIN;
  return domain ? [new URL(domain).origin] : [];
}

let cachedFormActionOrigins: string[] | undefined;

/** {@link formActionOrigins} of `process.env`, cached for the process. */
export function processFormActionOrigins(): string[] {
  cachedFormActionOrigins ??= formActionOrigins(process.env);
  return cachedFormActionOrigins;
}

/**
 * CSP sources of the captcha (captchaCspSources): with CAPTCHA_PROVIDER=turnstile, the Turnstile
 * origin in `script-src` and `frame-src`. The proxy adds them on share pages only, where the
 * scan flow may show the widget.
 */
export function captchaCsp(env: Env = process.env): CaptchaCspSources {
  return captchaCspSources(loadCaptchaClientConfig(env));
}

let cachedCaptchaCsp: CaptchaCspSources | undefined;

/** {@link captchaCsp} of `process.env`, cached for the process. */
export function processCaptchaCsp(): CaptchaCspSources {
  cachedCaptchaCsp ??= captchaCsp(process.env);
  return cachedCaptchaCsp;
}

/** A same-origin absolute path (`/x/y`): MediaPipe assets are self-hosted, never on a CDN. */
const sameOriginPath = z
  .string()
  .regex(/^\/(?!\/)[A-Za-z0-9._~\-/]*$/, { error: 'must be a same-origin path like /mediapipe' })
  .refine((p) => !p.split('/').includes('..'), { error: 'must not contain ..' });

const ratio = z.coerce.number().min(0).max(1);
const luma = z.coerce.number().min(0).max(255);

// Web-only tunables of the scan and download UI. Defaults are starting values; tune with the
// Phase 0 evaluation and real devices.
const webShareEnvSchema = z
  .object({
    /** Directory of the self-hosted MediaPipe wasm files (copied by scripts/copy-mediapipe.mjs). */
    FACE_DETECTOR_WASM_BASE_PATH: sameOriginPath.default('/mediapipe/dist'),
    /** The BlazeFace short-range model (.tflite), self-hosted. */
    FACE_DETECTOR_MODEL_PATH: sameOriginPath.default('/mediapipe/blaze_face_short_range.tflite'),
    WEB_FACE_GATE_MIN_FACE_WIDTH_RATIO: ratio.default(0.18),
    WEB_FACE_GATE_MIN_SCORE: ratio.default(0.6),
    WEB_FACE_GATE_MIN_BRIGHTNESS: luma.default(60),
    WEB_FACE_GATE_MAX_BRIGHTNESS: luma.default(235),
    WEB_FACE_GATE_MAX_NOSE_OFFSET_RATIO: z.coerce.number().min(0).max(2).default(0.35),
    /**
     * Zoom of the live selfie camera. Phones give getUserMedia the front camera's full wide
     * field of view, while their camera app crops it; 1.4 looks like the camera app. 1 = off.
     */
    WEB_FACE_CAMERA_ZOOM: z.coerce.number().min(1).max(3).default(1.4),
    WEB_ZIP_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2000),
    WEB_ZIP_POLL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(60 * 60_000)
      .default(15 * 60_000),
    WEB_IOS_SHARE_MAX_FILES: z.coerce.number().int().min(1).max(100).default(20),
    /** Photos fetched at once while a selection is prepared for "save to Photos". */
    WEB_PHOTO_PREFETCH_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
    /** Pause between the separate downloads of a selection (browsers that can't share files). */
    WEB_DOWNLOAD_GAP_MS: z.coerce.number().int().min(0).max(5000).default(400),
    /** ADR 0020: how often an open share page checks for new photos (0: never). */
    WEB_SHARE_LIVE_POLL_MS: z.coerce
      .number()
      .int()
      .refine((v) => v === 0 || (v >= 3000 && v <= 10 * 60_000), 'must be 0 or 3000–600000')
      .default(15_000),
    /** How often the studio polls GET /billing/payments/:id while a payment is pending. */
    WEB_BILLING_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(3000),
    /**
     * The plan the pricing page highlights as recommended (a plan code; empty: none). A
     * marketing choice, not a price: prices and plans always come from GET /plans.
     */
    WEB_PRICING_RECOMMENDED_PLAN: z.union([z.literal(''), planCodeSchema]).default('standard'),
    /** How often a drive listing refreshes while it shows a file still processing (copies, uploads). */
    WEB_DRIVE_PROCESSING_POLL_MS: z.coerce.number().int().min(1000).max(60_000).default(3000),
    /** Folder sync (ADR 0014): how often the watched folder is scanned. */
    WEB_FOLDER_SYNC_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(5 * 60_000)
      .default(5000),
    /**
     * Folder sync: how long a file must be untouched before it is uploaded, so a watermark
     * plugin that rewrites Lightroom's export right after it is written gets its version in.
     */
    WEB_FOLDER_SYNC_SETTLE_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(5 * 60_000)
      .default(20_000),
    /** ADR 0021: JPEG/WebP quality of a synced photo re-encoded with the watermark (0.5–1). */
    WEB_FOLDER_SYNC_WATERMARK_QUALITY: z.coerce.number().min(0.5).max(1).default(0.92),
    /** Folder sync: files in the upload queue at once (the rest wait for later scans). */
    WEB_FOLDER_SYNC_MAX_QUEUED: z.coerce.number().int().min(1).max(200).default(20),
    /** Folder sync: subfolder levels under the watched folder that are synced too. */
    WEB_FOLDER_SYNC_MAX_DEPTH: z.coerce.number().int().min(0).max(10).default(3),
    /** Folder sync: waits before retrying a failed upload, comma-separated ms; then it gives up. */
    WEB_FOLDER_SYNC_RETRY_DELAYS_MS: z
      .string()
      .default('30000,120000,600000')
      .transform((v) =>
        v
          .split(',')
          .filter((p) => p.trim() !== '')
          .map((p) => Number(p.trim())),
      )
      .pipe(
        z
          .array(
            z
              .number()
              .int()
              .min(0)
              .max(60 * 60_000),
          )
          .max(10),
      ),
  })
  .refine((e) => e.WEB_FACE_GATE_MIN_BRIGHTNESS < e.WEB_FACE_GATE_MAX_BRIGHTNESS, {
    error: 'WEB_FACE_GATE_MIN_BRIGHTNESS must be below WEB_FACE_GATE_MAX_BRIGHTNESS',
  });

/**
 * The scan flow's web-only settings: the quality gate and the self-hosted detector. The selfie
 * limits (count, size, JPEG quality) come from the API with the share meta, never from web env.
 */
export function clientFaceConfig(env: Env = process.env): ClientFaceConfig {
  const e = parseEnv(webShareEnvSchema, env, 'web share');
  return {
    gate: {
      minFaceWidthRatio: e.WEB_FACE_GATE_MIN_FACE_WIDTH_RATIO,
      minScore: e.WEB_FACE_GATE_MIN_SCORE,
      minBrightness: e.WEB_FACE_GATE_MIN_BRIGHTNESS,
      maxBrightness: e.WEB_FACE_GATE_MAX_BRIGHTNESS,
      maxNoseOffsetRatio: e.WEB_FACE_GATE_MAX_NOSE_OFFSET_RATIO,
    },
    detector: {
      wasmBasePath: e.FACE_DETECTOR_WASM_BASE_PATH.replace(/\/+$/, ''),
      modelPath: e.FACE_DETECTOR_MODEL_PATH,
    },
    cameraZoom: e.WEB_FACE_CAMERA_ZOOM,
    captcha: loadCaptchaClientConfig(env),
  };
}

/** Download tunables of the share page (ZIP_MAX_FILES comes from share meta). */
export function clientShareConfig(env: Env = process.env): ClientShareConfig {
  const e = parseEnv(webShareEnvSchema, env, 'web share');
  return {
    zipPollIntervalMs: e.WEB_ZIP_POLL_INTERVAL_MS,
    zipPollTimeoutMs: e.WEB_ZIP_POLL_TIMEOUT_MS,
    iosShareMaxFiles: e.WEB_IOS_SHARE_MAX_FILES,
    photoPrefetchConcurrency: e.WEB_PHOTO_PREFETCH_CONCURRENCY,
    downloadGapMs: e.WEB_DOWNLOAD_GAP_MS,
    livePollMs: e.WEB_SHARE_LIVE_POLL_MS,
  };
}

/**
 * Studio drive tunables (the processing refresh, and the owner ZIP polling as on share pages) and
 * how photographers pay.
 */
export interface ClientStudioConfig {
  processingPollMs: number;
  zipPollIntervalMs: number;
  zipPollTimeoutMs: number;
  /**
   * BILLING_MODE (ADR 0010). `offline`: no plans, checkout, subscription banner or "add storage"
   * prompts anywhere in the studio (the billing routes answer NOT_FOUND).
   */
  billingMode: BillingOperatingMode;
  /**
   * A viewer can sign in (viewerLoginAvailable of GET /auth/providers; src/lib/server/auth
   * viewerLoginOptions). False: shares can't be set to require_login (LOGIN_PROVIDER_UNAVAILABLE).
   */
  viewerLoginAvailable: boolean;
}

export function clientStudioConfig(
  env: Env = process.env,
  /** From viewerLoginOptions (an API call, so the layout passes it in). */
  viewerLogin = true,
): ClientStudioConfig {
  const e = parseEnv(webShareEnvSchema, env, 'web share');
  return {
    processingPollMs: e.WEB_DRIVE_PROCESSING_POLL_MS,
    zipPollIntervalMs: e.WEB_ZIP_POLL_INTERVAL_MS,
    zipPollTimeoutMs: e.WEB_ZIP_POLL_TIMEOUT_MS,
    billingMode: billingMode(env),
    viewerLoginAvailable: viewerLogin,
  };
}

/**
 * BILLING_MODE as the API reads it (loadBillingModeConfig, default `offline`). Read on the server
 * per request, never baked into the client bundle.
 */
export function billingMode(env: Env = process.env): BillingOperatingMode {
  return loadBillingModeConfig(env).mode;
}

/** True while photographers can't pay online (BILLING_MODE=offline, ADR 0010). */
export function billingOffline(env: Env = process.env): boolean {
  return billingMode(env) === 'offline';
}

/**
 * What the change-password form checks before calling the API (ADR 0010): the photographer
 * minimum from loadPhotographerPasswordPolicy, the same secret-free reader the API uses, so key,
 * bounds and default can't drift. The API's PASSWORD_TOO_WEAK stays the authority.
 */
export type ClientPasswordPolicy = PasswordLengthPolicy;

export function clientPasswordPolicy(env: Env = process.env): ClientPasswordPolicy {
  return loadPhotographerPasswordPolicy(env);
}

/** The pricing page's recommended plan code, or null for none. */
export function clientPricingConfig(env: Env = process.env): {
  recommendedPlanCode: string | null;
} {
  const e = parseEnv(webShareEnvSchema, env, 'web share');
  return {
    recommendedPlanCode:
      e.WEB_PRICING_RECOMMENDED_PLAN === '' ? null : e.WEB_PRICING_RECOMMENDED_PLAN,
  };
}

/** Folder sync tunables (ADR 0014; SyncEngineConfig without the UI's recent-list length). */
export interface ClientFolderSyncConfig {
  intervalMs: number;
  /** WEB_FOLDER_SYNC_SETTLE_MS. */
  settleMs: number;
  /** WEB_FOLDER_SYNC_WATERMARK_QUALITY. */
  watermarkQuality: number;
  maxQueued: number;
  maxDepth: number;
  retryDelaysMs: number[];
}

export function clientFolderSyncConfig(env: Env = process.env): ClientFolderSyncConfig {
  const e = parseEnv(webShareEnvSchema, env, 'web share');
  return {
    intervalMs: e.WEB_FOLDER_SYNC_INTERVAL_MS,
    settleMs: e.WEB_FOLDER_SYNC_SETTLE_MS,
    watermarkQuality: e.WEB_FOLDER_SYNC_WATERMARK_QUALITY,
    maxQueued: e.WEB_FOLDER_SYNC_MAX_QUEUED,
    maxDepth: e.WEB_FOLDER_SYNC_MAX_DEPTH,
    retryDelaysMs: e.WEB_FOLDER_SYNC_RETRY_DELAYS_MS,
  };
}

/** Studio billing tunables (plans and prices always come from the API). */
export interface ClientBillingConfig {
  paymentPollIntervalMs: number;
}

export function clientBillingConfig(env: Env = process.env): ClientBillingConfig {
  const e = parseEnv(webShareEnvSchema, env, 'web share');
  return { paymentPollIntervalMs: e.WEB_BILLING_POLL_INTERVAL_MS };
}

/** A Google Analytics 4 measurement id (`G-` and letters or digits). */
const GA_MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;

/**
 * GA_MEASUREMENT_ID (web env; ADR 0017): the Google Analytics 4 property of every web page
 * (share pages, studio, home; never the admin app), or null when unset. Owner decision
 * 2026-11-13: loaded on every page without a cookie banner. Only page views go to Google (GA4's
 * own history tracking); no selfie, face data or file name is ever sent. Throws on a malformed id
 * so a typo fails at start instead of silently tracking nothing.
 */
export function analyticsId(env: Env = process.env): string | null {
  const raw = env.GA_MEASUREMENT_ID?.trim() ?? '';
  if (raw === '') return null;
  if (!GA_MEASUREMENT_ID.test(raw)) {
    throw new Error('Invalid web configuration: GA_MEASUREMENT_ID must look like G-XXXXXXXXXX');
  }
  return raw;
}

let cachedAnalyticsId: string | null | undefined;

/** {@link analyticsId} of `process.env`, cached for the process. */
export function processAnalyticsId(): string | null {
  if (cachedAnalyticsId === undefined) cachedAnalyticsId = analyticsId(process.env);
  return cachedAnalyticsId;
}
