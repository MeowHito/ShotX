import type { CaptchaAction } from '@shotx/shared';

/**
 * Cloudflare Turnstile in the browser (ADR 0008 section 7). The script is loaded only when the
 * API asks for a challenge (RATE_LIMITED with `details.captcha`), never on a normal visit, and
 * rendered explicitly (TURNSTILE_SCRIPT_URL has `render=explicit`).
 *
 * CSP: our own nonced code inserts the script element, which 'strict-dynamic' trusts (the
 * Turnstile origin is listed in `script-src` too, for browsers without 'strict-dynamic'); the
 * widget runs in an iframe from the same origin (`frame-src`). Only on share pages.
 */

/** The part of `window.turnstile` the share page uses. */
export interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: CaptchaAction;
      language?: string;
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
      'timeout-callback': () => void;
    },
  ) => string | undefined;
  remove: (widgetId: string) => void;
}

/** Loads (once) and returns the Turnstile API. Tests pass a fake. */
export type TurnstileLoader = () => Promise<TurnstileApi>;

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * A loader that appends the Turnstile script on first use and resolves with `window.turnstile`.
 * A failed load can be retried (the next call adds the script again).
 */
export function createTurnstileLoader(scriptUrl: string): TurnstileLoader {
  let loading: Promise<TurnstileApi> | null = null;
  return () => {
    if (typeof window !== 'undefined' && window.turnstile !== undefined) {
      return Promise.resolve(window.turnstile);
    }
    loading ??= new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.onload = () => {
        if (window.turnstile !== undefined) resolve(window.turnstile);
        else reject(new Error('Turnstile did not initialise'));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error('Turnstile script failed to load'));
      };
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}
