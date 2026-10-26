import {
  type AuthClientConfig,
  type AuthProviderName,
  type CognitoPoolConfig,
  type Env,
  loadAppConfig,
  loadAuthClientConfig,
  loadAuthProviderConfig,
  loadAwsConfig,
  loadBffAuthConfig,
  loadCognitoConfig,
  loadInternalApiConfig,
  loadMediaUrlSignerConfig,
  loadUploadConfig,
  parseEnv,
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
 * Origins the browser PUTs upload parts to (CSP `connect-src`). The API presigns virtual-hosted
 * URLs on the regional endpoint. With MEDIA_BUCKET set that is exactly one origin; without it
 * (infra doesn't pass MEDIA_BUCKET to web yet) any bucket on the regional endpoint. LocalStack's
 * AWS_ENDPOINT_URL is added for local development.
 */
export function uploadOrigins(env: Env = process.env): string[] {
  const aws = loadAwsConfig(env);
  const origins: string[] = [];
  const bucket = env.MEDIA_BUCKET;
  if (bucket !== undefined && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    origins.push(`https://${bucket}.s3.${aws.region}.amazonaws.com`);
  } else {
    origins.push(`https://*.s3.${aws.region}.amazonaws.com`);
  }
  if (aws.endpointUrl !== null) origins.push(new URL(aws.endpointUrl).origin);
  return origins;
}

/**
 * Origins of signed media URLs besides the site (CSP `img-src`/`media-src`). On AWS media is
 * same-origin (`/media` on CloudFront), so this is empty; with MEDIA_URL_SIGNER=s3-presign (the
 * shared loader refuses it outside APP_STAGE=local) URLs are signed on AWS_ENDPOINT_URL.
 */
export function mediaOrigins(env: Env = process.env): string[] {
  if (loadMediaUrlSignerConfig(env).signer !== 's3-presign') return [];
  const aws = loadAwsConfig(env);
  return aws.endpointUrl === null ? [] : [new URL(aws.endpointUrl).origin];
}

let cachedMediaOrigins: string[] | undefined;

/** {@link mediaOrigins} of `process.env`, cached for the process (the proxy runs per request). */
export function processMediaOrigins(): string[] {
  cachedMediaOrigins ??= mediaOrigins(process.env);
  return cachedMediaOrigins;
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
    WEB_ZIP_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2000),
    WEB_ZIP_POLL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(60 * 60_000)
      .default(15 * 60_000),
    WEB_IOS_SHARE_MAX_FILES: z.coerce.number().int().min(1).max(100).default(20),
    /** How often the studio polls GET /billing/payments/:id while a payment is pending. */
    WEB_BILLING_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(3000),
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
  };
}

/** Download tunables of the share page (ZIP_MAX_FILES comes from share meta). */
export function clientShareConfig(env: Env = process.env): ClientShareConfig {
  const e = parseEnv(webShareEnvSchema, env, 'web share');
  return {
    zipPollIntervalMs: e.WEB_ZIP_POLL_INTERVAL_MS,
    zipPollTimeoutMs: e.WEB_ZIP_POLL_TIMEOUT_MS,
    iosShareMaxFiles: e.WEB_IOS_SHARE_MAX_FILES,
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
