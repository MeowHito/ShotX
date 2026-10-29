'use client';

import { ME_ROUTES } from '@shotx/shared';
import { Button } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useRef, useState } from 'react';
import { type ApiClient, createPublicApiClient } from '@/lib/api/client';
import { AUTH_PATHS } from '@/lib/auth/handlers';

/** Longest wait for the viewer-session deletion before logging out anyway. */
const VIEWER_SESSION_TIMEOUT_MS = 3000;

/**
 * Logout: first `DELETE /api/me/viewer-session` straight to the API (the `shotx_vs` cookie is
 * scoped to /api, so only that request carries it and the API can end the session), then the
 * normal form POST to /auth/logout. Logout never waits more than a few seconds for the first step.
 * `form` is the hidden form to render; `logout()` runs both steps (the account menu calls it).
 */
export function useLogout({
  publicApi,
  onSubmitForm,
}: {
  publicApi?: ApiClient;
  onSubmitForm?: (form: HTMLFormElement) => void;
} = {}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);

  async function logout() {
    if (busy) return;
    setBusy(true);
    const api = publicApi ?? createPublicApiClient();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIEWER_SESSION_TIMEOUT_MS);
    await api
      .call(ME_ROUTES.deleteViewerSession, { signal: controller.signal })
      .catch(() => undefined);
    clearTimeout(timer);
    const form = formRef.current;
    if (form === null) return;
    if (onSubmitForm) onSubmitForm(form);
    else form.submit();
  }

  return { formRef, busy, logout };
}

export function LogoutButton({
  publicApi,
  onSubmitForm,
}: {
  /** Tests inject the fake API and observe the form submission. */
  publicApi?: ApiClient;
  onSubmitForm?: (form: HTMLFormElement) => void;
}) {
  const t = useTranslations('studio');
  const { formRef, busy, logout } = useLogout({ publicApi, onSubmitForm });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void logout();
  }

  return (
    <form ref={formRef} action={AUTH_PATHS.logout} method="post" onSubmit={submit}>
      <Button type="submit" variant="ghost" size="sm" disabled={busy}>
        {t('logout')}
      </Button>
    </form>
  );
}
