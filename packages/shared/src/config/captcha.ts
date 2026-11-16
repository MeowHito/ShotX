import { z } from 'zod';
import type { CaptchaAction, CaptchaRejectReason } from '../domain';
import { runsOffAws } from './aws-clients';
import { type Env, parseEnv } from './env';
import { int, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from './fields';
import { loadAppConfig } from './runtime';
import { isLocalStage, LOCAL_DEV_APP_STAGE } from './stage-gate';

// CAPTCHA on face search and face deletion (ADR 0008 section 7, amending ADR 0007). The spec's
// "WAF CAPTCHA when abused" becomes, on the VPS, Cloudflare Turnstile shown only after a rate
// limit hit, never on every scan, so the post-race spike isn't slowed:
//
// 1. The api enforces FACE_SEARCH_RATE_* (per IP, share and viewer; face search and face deletion
//    share them). Over a limit it answers RATE_LIMITED with RateLimitedDetails: `captcha` set when
//    a Turnstile challenge can unlock more attempts, null when only waiting helps.
// 2. The web app shows the Turnstile widget (action `face_search` or `face_deletion`) and repeats
//    the request with the token in the CAPTCHA_TOKEN_HEADER header. The token is a header, not a
//    multipart field, so the api decides before it reads (and buffers) any selfie.
// 3. Only when the request is over a limit, the api verifies the token with siteverify (secret,
//    remoteip = the client IP, an idempotency_key per verification, timeout
//    TURNSTILE_VERIFY_TIMEOUT_MS) and checks `success`, `hostname` (PUBLIC_BASE_URL's host) and
//    `action` (turnstileVerdict). Tokens are single-use and live 300 s at Cloudflare.
// 4. A passed token issues a grant: CAPTCHA_GRANT_ATTEMPTS more requests within
//    CAPTCHA_GRANT_TTL_SECONDS for the same share, viewer and client IP, exempt from the three
//    FACE_SEARCH_RATE_* limits (the Rekognition token buckets still bound the calls). At most
//    CAPTCHA_GRANTS_PER_IP grants per CAPTCHA_GRANTS_PER_IP_WINDOW_SECONDS per client IP; past
//    that, RATE_LIMITED with `captcha: null`.
// 5. A token that fails answers RATE_LIMITED again, with `captcha.rejected` saying why
//    (CAPTCHA_REJECT_REASONS in domain); the selfies are never read. Under the limit a token is ignored.
//
// On the AWS stacks (CAPTCHA_PROVIDER=waf, the default) the edge WAF challenges instead and the
// api answers RATE_LIMITED with `captcha: null`, as before.

/**
 * - `waf`: AWS WAF CAPTCHA at the edge (AWS stacks; the default so infra is unchanged).
 * - `turnstile`: Cloudflare Turnstile after a rate-limit hit (the VPS, ADR 0008 section 7).
 * - `none`: no challenge, only the rate limits (local development; refused off AWS elsewhere).
 */
export const CAPTCHA_PROVIDERS = ['waf', 'turnstile', 'none'] as const;
export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];

/** The Turnstile `action` of each guarded route (CAPTCHA_ACTIONS). */
export const TURNSTILE_ACTIONS = {
  faceSearch: 'face_search',
  faceDeletion: 'face_deletion',
  /** ADR 0026: POST /signup/free (the token is in the body's `captchaToken`). */
  signupFree: 'signup_free',
} as const satisfies Record<string, CaptchaAction>;

/** The origin Turnstile is served from: the CSP's `script-src` and `frame-src` exception. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** The widget script (explicit rendering, for the client-rendered share page). */
export const TURNSTILE_SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

/** Server-side token verification endpoint. */
export const TURNSTILE_SITEVERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

/**
 * Cloudflare's documented test keys (public, so refused outside APP_STAGE=local, like the example
 * secrets). Site keys: always passes, always blocks, passes invisibly, blocks invisibly, forces an
 * interactive challenge. Secret keys: always passes, always fails, "token already spent".
 */
export const TURNSTILE_TEST_SITE_KEYS: ReadonlySet<string> = new Set([
  '1x00000000000000000000AA',
  '2x00000000000000000000AB',
  '1x00000000000000000000BB',
  '2x00000000000000000000BB',
  '3x00000000000000000000FF',
]);
export const TURNSTILE_TEST_SECRET_KEYS: ReadonlySet<string> = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

const turnstileKey = () =>
  z.string().regex(/^[0-3]x[A-Za-z0-9_-]{10,120}$/, { error: 'must be a Turnstile key' });

const D = {
  verifyTimeoutMs: 5_000,
  grantAttempts: 5,
  grantTtlSeconds: 10 * SECONDS_PER_MINUTE,
  grantsPerIp: 10,
  grantsPerIpWindowSeconds: SECONDS_PER_HOUR,
} as const;

/** Defaults of the grant and verification settings (assumptions; load-test before launch). */
export const CAPTCHA_DEFAULTS = D;

const providerEnvSchema = z.object({
  CAPTCHA_PROVIDER: z.enum(CAPTCHA_PROVIDERS).default('waf'),
  APP_STAGE: z.string().optional(),
});

/** CAPTCHA_PROVIDER, with the stage rules shared by the api and web loaders. */
function readProvider(env: Env, name: string): CaptchaProvider {
  const { CAPTCHA_PROVIDER, APP_STAGE } = parseEnv(providerEnvSchema, env, name);
  // `none` only on laptops and in test runs (NODE_ENV=test never reaches a deployed container).
  if (
    CAPTCHA_PROVIDER === 'none' &&
    APP_STAGE !== LOCAL_DEV_APP_STAGE &&
    env.NODE_ENV !== 'test' &&
    runsOffAws(env)
  ) {
    throw new Error(
      `Invalid ${name} configuration: CAPTCHA_PROVIDER=none off AWS outside APP_STAGE=${LOCAL_DEV_APP_STAGE}; use turnstile`,
    );
  }
  if (CAPTCHA_PROVIDER === 'waf' && APP_STAGE !== LOCAL_DEV_APP_STAGE && runsOffAws(env)) {
    throw new Error(
      `Invalid ${name} configuration: CAPTCHA_PROVIDER=waf off AWS (there is no WAF in front); use turnstile`,
    );
  }
  return CAPTCHA_PROVIDER;
}

function refuseTestKey(
  env: Env,
  key: string,
  keys: ReadonlySet<string>,
  what: string,
  name: string,
) {
  if (keys.has(key) && !isLocalStage(env, name)) {
    throw new Error(
      `Invalid ${name} configuration: ${what} is a published Cloudflare test key, allowed only on APP_STAGE=${LOCAL_DEV_APP_STAGE} with a non-production NODE_ENV`,
    );
  }
}

const apiEnvSchema = z.object({
  /** Secret: api only, never sent to browsers or logged. */
  TURNSTILE_SECRET_KEY: turnstileKey().optional(),
  TURNSTILE_VERIFY_TIMEOUT_MS: int(500, 30_000).default(D.verifyTimeoutMs),
  CAPTCHA_GRANT_ATTEMPTS: int(1, 100).default(D.grantAttempts),
  CAPTCHA_GRANT_TTL_SECONDS: int(SECONDS_PER_MINUTE, SECONDS_PER_DAY).default(D.grantTtlSeconds),
  CAPTCHA_GRANTS_PER_IP: int(1, 1000).default(D.grantsPerIp),
  CAPTCHA_GRANTS_PER_IP_WINDOW_SECONDS: int(SECONDS_PER_MINUTE, SECONDS_PER_DAY).default(
    D.grantsPerIpWindowSeconds,
  ),
});

/** What a passed challenge buys, and how often (see the module comment). */
export interface CaptchaGrantConfig {
  /** Requests a grant lets past the FACE_SEARCH_RATE_* limits. */
  attempts: number;
  /** Lifetime of a grant (Redis TTL); unused attempts expire with it. */
  ttlSeconds: number;
  /** Most grants issued per client IP per `perIpWindowSeconds`. */
  perIp: number;
  perIpWindowSeconds: number;
}

export type CaptchaConfig =
  | { provider: 'waf' | 'none' }
  | {
      provider: 'turnstile';
      /** TURNSTILE_SECRET_KEY. Secret: never log it. */
      secretKey: string;
      verifyUrl: string;
      verifyTimeoutMs: number;
      /** Host the token must have been solved on: PUBLIC_BASE_URL's hostname. */
      expectedHostname: string;
      /** True with a Cloudflare test secret (local only): skip the hostname check. */
      testKey: boolean;
      grant: CaptchaGrantConfig;
    };

/**
 * Reads CAPTCHA_PROVIDER (default `waf`) and, for `turnstile`, TURNSTILE_SECRET_KEY (required),
 * TURNSTILE_VERIFY_TIMEOUT_MS, CAPTCHA_GRANT_ATTEMPTS, CAPTCHA_GRANT_TTL_SECONDS,
 * CAPTCHA_GRANTS_PER_IP, CAPTCHA_GRANTS_PER_IP_WINDOW_SECONDS and PUBLIC_BASE_URL (api only).
 * `none` and `waf` are refused off AWS outside APP_STAGE=local, and Cloudflare's
 * test secrets outside APP_STAGE=local. The grant settings are validated with every provider.
 */
export function loadCaptchaConfig(env: Env): CaptchaConfig {
  const name = 'captcha';
  const provider = readProvider(env, name);
  const e = parseEnv(apiEnvSchema, env, name);
  if (provider !== 'turnstile') return { provider };
  if (e.TURNSTILE_SECRET_KEY === undefined) {
    throw new Error(
      `Invalid ${name} configuration: TURNSTILE_SECRET_KEY is required with CAPTCHA_PROVIDER=turnstile`,
    );
  }
  refuseTestKey(
    env,
    e.TURNSTILE_SECRET_KEY,
    TURNSTILE_TEST_SECRET_KEYS,
    'TURNSTILE_SECRET_KEY',
    name,
  );
  return {
    provider,
    secretKey: e.TURNSTILE_SECRET_KEY,
    verifyUrl: TURNSTILE_SITEVERIFY_URL,
    verifyTimeoutMs: e.TURNSTILE_VERIFY_TIMEOUT_MS,
    expectedHostname: new URL(loadAppConfig(env).publicBaseUrl).hostname,
    testKey: TURNSTILE_TEST_SECRET_KEYS.has(e.TURNSTILE_SECRET_KEY),
    grant: {
      attempts: e.CAPTCHA_GRANT_ATTEMPTS,
      ttlSeconds: e.CAPTCHA_GRANT_TTL_SECONDS,
      perIp: e.CAPTCHA_GRANTS_PER_IP,
      perIpWindowSeconds: e.CAPTCHA_GRANTS_PER_IP_WINDOW_SECONDS,
    },
  };
}

// --- Web (public) ------------------------------------------------------------------------------

const webEnvSchema = z.object({
  /** Public: rendered into the share page. */
  TURNSTILE_SITE_KEY: turnstileKey().optional(),
});

/** What the share page needs. Nothing here is secret. */
export type CaptchaClientConfig =
  { provider: 'waf' | 'none' } | { provider: 'turnstile'; siteKey: string; scriptUrl: string };

/**
 * Reads CAPTCHA_PROVIDER and, for `turnstile`, TURNSTILE_SITE_KEY (required; web). Same stage
 * rules as loadCaptchaConfig; Cloudflare's test site keys are refused outside APP_STAGE=local.
 * The AWS WAF integration keys stay in loadWafCaptchaConfig.
 */
export function loadCaptchaClientConfig(env: Env): CaptchaClientConfig {
  const name = 'captcha client';
  const provider = readProvider(env, name);
  const e = parseEnv(webEnvSchema, env, name);
  if (provider !== 'turnstile') return { provider };
  if (e.TURNSTILE_SITE_KEY === undefined) {
    throw new Error(
      `Invalid ${name} configuration: TURNSTILE_SITE_KEY is required with CAPTCHA_PROVIDER=turnstile`,
    );
  }
  refuseTestKey(env, e.TURNSTILE_SITE_KEY, TURNSTILE_TEST_SITE_KEYS, 'TURNSTILE_SITE_KEY', name);
  return { provider, siteKey: e.TURNSTILE_SITE_KEY, scriptUrl: TURNSTILE_SCRIPT_URL };
}

/** CSP sources the captcha adds to the web app's policy. */
export interface CaptchaCspSources {
  scriptSrc: string[];
  frameSrc: string[];
  connectSrc: string[];
}

/**
 * The CSP additions for the configured captcha: with `turnstile`, TURNSTILE_ORIGIN in
 * `script-src` and `frame-src` (ADR 0008 section 7: an explicit exception to "no CDN"; the
 * widget talks to Cloudflare from its own iframe, so `connect-src` gains nothing). Nothing for
 * `waf` and `none` (the WAF challenge is an edge interstitial, not part of the page).
 */
export function captchaCspSources(config: CaptchaClientConfig): CaptchaCspSources {
  if (config.provider !== 'turnstile') return { scriptSrc: [], frameSrc: [], connectSrc: [] };
  return { scriptSrc: [TURNSTILE_ORIGIN], frameSrc: [TURNSTILE_ORIGIN], connectSrc: [] };
}

// --- Verification (api) ------------------------------------------------------------------------

/** The siteverify response fields the api reads (unknown fields are dropped). */
export const turnstileSiteverifyResponseSchema = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string()).default([]),
  challenge_ts: z.string().optional(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});
export type TurnstileSiteverifyResponse = z.output<typeof turnstileSiteverifyResponseSchema>;

/** Siteverify error codes that mean our side is misconfigured or Cloudflare failed. */
const UNAVAILABLE_CODES = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
  'internal-error',
]);

/**
 * Judges a siteverify response (pure; the api does the HTTP call, and passes null when it failed
 * or timed out). Passes only with `success`, the expected action and, unless `testKey`, the
 * expected hostname.
 */
export function turnstileVerdict(
  response: unknown,
  expected: { hostname: string; action: CaptchaAction; testKey?: boolean },
): { ok: true } | { ok: false; reason: CaptchaRejectReason } {
  if (response === null) return { ok: false, reason: 'unavailable' };
  const parsed = turnstileSiteverifyResponseSchema.safeParse(response);
  if (!parsed.success) return { ok: false, reason: 'unavailable' };
  const r = parsed.data;
  if (!r.success) {
    const codes = r['error-codes'];
    if (codes.some((c) => UNAVAILABLE_CODES.has(c))) return { ok: false, reason: 'unavailable' };
    if (codes.includes('timeout-or-duplicate')) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
  if (expected.testKey !== true && r.hostname?.toLowerCase() !== expected.hostname.toLowerCase()) {
    return { ok: false, reason: 'invalid' };
  }
  // Test secrets answer without an action; real tokens always carry the widget's.
  if (expected.testKey !== true && r.action !== expected.action) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true };
}
