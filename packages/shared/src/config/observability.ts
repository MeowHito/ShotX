import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { httpUrl, secret } from './fields';

/** `https://<public key>@<host>/<project id>`. Error messages never repeat the value. */
const sentryDsn = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username !== '' &&
        url.hostname !== '' &&
        /^\/(.+\/)?\d+$/.test(url.pathname) &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  },
  { error: 'must be a Sentry DSN (https://<key>@<host>/<project id>)' },
);

const sentryEnvSchema = z.object({ SENTRY_DSN: sentryDsn.optional() });

export interface SentryConfig {
  /**
   * Null disables error reporting (local development). Face-search request bodies must be
   * excluded from every event: selfies are never persisted.
   */
  dsn: string | null;
}

/** Reads SENTRY_DSN (optional; every service). */
export function loadSentryConfig(env: Env): SentryConfig {
  return { dsn: parseEnv(sentryEnvSchema, env, 'Sentry').SENTRY_DSN ?? null };
}

const wafCaptchaEnvSchema = z
  .object({
    WAF_CAPTCHA_API_KEY: secret().optional(),
    WAF_CAPTCHA_SCRIPT_URL: httpUrl({ path: true, httpsOnly: true }).optional(),
  })
  .refine(
    (e) => (e.WAF_CAPTCHA_API_KEY === undefined) === (e.WAF_CAPTCHA_SCRIPT_URL === undefined),
    {
      error:
        'WAF_CAPTCHA_API_KEY and WAF_CAPTCHA_SCRIPT_URL must be set together (or both left empty)',
    },
  );

/** AWS WAF CAPTCHA JavaScript integration on the share page (web: face search). */
export interface WafCaptchaConfig {
  /** The WAF application integration API key. It is sent to browsers, but don't log it. */
  apiKey: string;
  /** URL of the CAPTCHA `jsapi.js`. */
  scriptUrl: string;
}

/**
 * Reads WAF_CAPTCHA_API_KEY and WAF_CAPTCHA_SCRIPT_URL (web). They are created in the WAF console
 * after deploy, so both may be unset; the loader then returns null and the share page relies on
 * the WAF's interstitial CAPTCHA only.
 */
export function loadWafCaptchaConfig(env: Env): WafCaptchaConfig | null {
  const e = parseEnv(wafCaptchaEnvSchema, env, 'WAF CAPTCHA');
  return e.WAF_CAPTCHA_API_KEY !== undefined && e.WAF_CAPTCHA_SCRIPT_URL !== undefined
    ? { apiKey: e.WAF_CAPTCHA_API_KEY, scriptUrl: e.WAF_CAPTCHA_SCRIPT_URL }
    : null;
}
