import { randomUUID } from 'node:crypto';
import {
  type CaptchaAction,
  type CaptchaConfig,
  type CaptchaRejectReason,
  turnstileVerdict,
} from '@shotx/shared';

// Cloudflare Turnstile verification for face search and face deletion after a rate-limit hit
// (ADR 0008 section 7; the flow is described in packages/shared config/captcha.ts). Tokens and
// the secret are never logged; the client IP is sent to Cloudflare only as `remoteip`.

/** Injection token of the CaptchaVerifier (null unless CAPTCHA_PROVIDER=turnstile). */
export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

export type CaptchaVerdict = { ok: true } | { ok: false; reason: CaptchaRejectReason };

export interface CaptchaVerifier {
  /** Verifies one token (single-use at Cloudflare). Never throws: failures are `unavailable`. */
  verify(input: {
    token: string;
    remoteIp: string;
    action: CaptchaAction;
  }): Promise<CaptchaVerdict>;
}

type TurnstileConfig = Extract<CaptchaConfig, { provider: 'turnstile' }>;

/** The HTTP client of siteverify (global fetch in production; a fake in tests). */
export type SiteverifyFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Turnstile siteverify: POST secret, response, remoteip and an idempotency_key (one per
 * verification) with TURNSTILE_VERIFY_TIMEOUT_MS per attempt; one retry with the same key when
 * the request itself failed (network error or timeout), so Cloudflare answers the retry like the
 * first attempt instead of "already spent". The JSON is judged by the shared turnstileVerdict
 * (success, hostname = PUBLIC_BASE_URL's host, action). Anything else fails closed: `unavailable`.
 */
export class TurnstileVerifier implements CaptchaVerifier {
  constructor(
    private readonly config: TurnstileConfig,
    private readonly fetch: SiteverifyFetch = (url, init) => globalThis.fetch(url, init),
  ) {}

  async verify(input: {
    token: string;
    remoteIp: string;
    action: CaptchaAction;
  }): Promise<CaptchaVerdict> {
    const body = new URLSearchParams({
      secret: this.config.secretKey,
      response: input.token,
      remoteip: input.remoteIp,
      idempotency_key: randomUUID(),
    }).toString();
    let json: unknown = null;
    for (let attempt = 0; attempt < 2 && json === null; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(this.config.verifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.verifyTimeoutMs),
        });
      } catch {
        continue; // network error or timeout: retry once with the same idempotency key
      }
      if (!response.ok) break;
      try {
        json = await response.json();
      } catch {
        break;
      }
    }
    return turnstileVerdict(json, {
      hostname: this.config.expectedHostname,
      action: input.action,
      testKey: this.config.testKey,
    });
  }
}

/** Fake verifier for tests: tokens map to verdicts; every call is recorded. */
export class FakeCaptchaVerifier implements CaptchaVerifier {
  readonly calls: { token: string; remoteIp: string; action: CaptchaAction }[] = [];
  /** Tokens that pass, and what the rest answer. */
  readonly valid = new Set<string>();
  rejectWith: CaptchaRejectReason = 'invalid';

  verify(input: {
    token: string;
    remoteIp: string;
    action: CaptchaAction;
  }): Promise<CaptchaVerdict> {
    this.calls.push(input);
    if (this.valid.has(input.token)) {
      this.valid.delete(input.token); // single-use, like Cloudflare
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false, reason: this.rejectWith });
  }
}
