'use client';

import type { CaptchaAction } from '@shotx/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { TurnstileApi, TurnstileLoader } from '@/lib/captcha/turnstile';

/** Why the widget gave no token: it failed (script, network, Cloudflare) or the challenge timed out. */
export type CaptchaFailure = 'error' | 'expired';

/**
 * The Turnstile widget, rendered explicitly with the public site key and the route's `action`.
 * Its token goes straight to `onToken` (the scan flow repeats the request with it); every mount
 * is a fresh widget, so a refused token is retried by remounting (a new `key`).
 */
export function CaptchaChallenge({
  loader,
  siteKey,
  action,
  onToken,
  onFailure,
}: {
  loader: TurnstileLoader;
  siteKey: string;
  action: CaptchaAction;
  onToken: (token: string) => void;
  onFailure: (failure: CaptchaFailure) => void;
}) {
  const t = useTranslations('capture');
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onFailure });
  useEffect(() => {
    callbacks.current = { onToken, onFailure };
  });

  useEffect(() => {
    let cancelled = false;
    let api: TurnstileApi | null = null;
    let widgetId: string | undefined;
    loader().then(
      (turnstile) => {
        if (cancelled || container.current === null) return;
        api = turnstile;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          language: 'th',
          callback: (token) => callbacks.current.onToken(token),
          'error-callback': () => callbacks.current.onFailure('error'),
          'expired-callback': () => callbacks.current.onFailure('expired'),
          'timeout-callback': () => callbacks.current.onFailure('expired'),
        });
      },
      () => {
        if (!cancelled) callbacks.current.onFailure('error');
      },
    );
    return () => {
      cancelled = true;
      if (api !== null && widgetId !== undefined) api.remove(widgetId);
    };
  }, [loader, siteKey, action]);

  return <div ref={container} role="group" aria-label={t('captchaLabel')} className="min-h-16" />;
}
