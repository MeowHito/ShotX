import { ErrorCode } from '@shotx/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { AUTH_PATHS, type AuthDeps } from '@/lib/auth/handlers';
import { handlePasswordResetConfirm, handlePasswordResetRequest } from '@/lib/auth/password';
import type { AuthProvider, AuthTokens } from '@/lib/auth/provider';
import { AuthProviderError } from '@/lib/auth/provider';
import { cookieNames } from '@/lib/auth/session';
import { navigateTo } from '@/lib/browser/navigate';
import { th } from '@/messages/th';
import { ForgotPasswordForm } from './forgot-password-form';
import { LoginButtons } from './login-buttons';
import { ResetPasswordForm } from './reset-password-form';

// ADR 0025: "forgot password" by email, browser side and web's route handlers.

vi.mock('@/lib/browser/navigate', () => ({ navigateTo: vi.fn() }));
const navigate = vi.mocked(navigateTo);

const BASE = 'https://photos.example.com';
const TOKEN = 'a'.repeat(43);
const NEW_PW = 'my-own-Secret-77';

function renderIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider
      locale={DEFAULT_LOCALE}
      messages={MESSAGES[DEFAULT_LOCALE]}
      timeZone={TIME_ZONE}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

/** A same-origin fetch that records the JSON bodies and answers `respond`. */
function recorder(respond: () => Response) {
  const sent: { path: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    sent.push({ path: input as string, body: JSON.parse(init?.body as string) as unknown });
    return Promise.resolve(respond());
  };
  return { sent, fetch };
}

const apiError = (status: number, code: ErrorCode) =>
  new Response(JSON.stringify({ code, message: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  navigate.mockReset();
});

describe('sign-in page', () => {
  it('links to "forgot password" when the reset is available, else says ask the admin', () => {
    const { unmount } = renderIntl(
      <LoginButtons
        options={{ password: true, passwordReset: true, oidc: [], devLogin: false }}
        next="/studio"
      />,
    );
    expect(screen.getByRole('link', { name: th.login.forgot })).toHaveAttribute(
      'href',
      AUTH_PATHS.forgotPasswordPage,
    );
    expect(screen.queryByText(th.login.forgotAskAdmin)).toBeNull();
    unmount();
    renderIntl(
      <LoginButtons options={{ password: true, oidc: [], devLogin: false }} next="/studio" />,
    );
    expect(screen.queryByRole('link', { name: th.login.forgot })).toBeNull();
    expect(screen.getByText(th.login.forgotAskAdmin)).toBeInTheDocument();
  });
});

describe('forgot password form', () => {
  it('sends the email and says to check the inbox', async () => {
    const r = recorder(() => new Response(null, { status: 204 }));
    renderIntl(<ForgotPasswordForm fetch={r.fetch} />);
    await userEvent.click(screen.getByRole('button', { name: th.passwordReset.send }));
    expect(screen.getByText(th.passwordReset.emailMissing)).toBeInTheDocument();
    expect(r.sent).toHaveLength(0);

    await userEvent.type(screen.getByLabelText(th.passwordReset.email), ' somchai@example.com ');
    await userEvent.click(screen.getByRole('button', { name: th.passwordReset.send }));
    expect(await screen.findByText(th.passwordReset.sentTitle)).toBeInTheDocument();
    expect(r.sent).toEqual([
      { path: AUTH_PATHS.passwordResetRequest, body: { email: 'somchai@example.com' } },
    ]);
  });
});

describe('reset password form', () => {
  async function fill(next: string, confirm = next) {
    await userEvent.type(screen.getByLabelText(th.password.newPassword), next);
    await userEvent.type(screen.getByLabelText(th.password.confirm), confirm);
    await userEvent.click(screen.getByRole('button', { name: th.passwordReset.save }));
  }

  it('sets the new password with the token from the link and opens the studio', async () => {
    const r = recorder(() => new Response(null, { status: 204 }));
    renderIntl(
      <ResetPasswordForm minLength={10} fetch={r.fetch} initialHash={`#token=${TOKEN}`} />,
    );
    await fill(NEW_PW, 'something-else-1');
    expect(screen.getByText(th.password.mismatch)).toBeInTheDocument();
    expect(r.sent).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText(th.password.confirm));
    await userEvent.type(screen.getByLabelText(th.password.confirm), NEW_PW);
    await userEvent.click(screen.getByRole('button', { name: th.passwordReset.save }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/studio'));
    expect(r.sent).toEqual([
      { path: AUTH_PATHS.passwordResetConfirm, body: { token: TOKEN, newPassword: NEW_PW } },
    ]);
  });

  it('offers a new link when the link is missing, expired or used', async () => {
    const { unmount } = renderIntl(<ResetPasswordForm minLength={10} initialHash="" />);
    expect(await screen.findByText(th.passwordReset.linkInvalid)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.passwordReset.requestNew })).toHaveAttribute(
      'href',
      AUTH_PATHS.forgotPasswordPage,
    );
    unmount();

    const r = recorder(() => apiError(400, ErrorCode.PASSWORD_RESET_INVALID));
    renderIntl(
      <ResetPasswordForm minLength={10} fetch={r.fetch} initialHash={`#token=${TOKEN}`} />,
    );
    await fill(NEW_PW);
    expect(await screen.findByText(th.passwordReset.linkInvalid)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('web route handlers', () => {
  const tokens: AuthTokens = {
    accessToken: 'header.eyJzdWIiOiJ4IiwiZXhwIjo0MTAyNDQ0ODAwfQ.sig',
    refreshToken: 'r'.repeat(43),
    expiresIn: 900,
    refreshExpiresIn: 86_400,
    user: { email: 'somchai@example.com', name: 'สมชาย' },
  };

  function deps(provider: Partial<AuthProvider>): AuthDeps {
    return {
      provider: { revoke: () => Promise.resolve(), ...provider } as AuthProvider,
      publicBaseUrl: BASE,
      secureCookies: true,
      now: () => 1_700_000_000_000,
    };
  }

  const post = (path: string, body: unknown, origin = BASE) =>
    new Request(`${BASE}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin },
    });

  it('request: 204 for a valid email, refuses other origins and bad bodies', async () => {
    const requestPasswordReset = vi.fn(() => Promise.resolve());
    const d = deps({ requestPasswordReset });
    const ok = await handlePasswordResetRequest(
      post(AUTH_PATHS.passwordResetRequest, { email: 'a@example.com' }),
      d,
    );
    expect(ok.status).toBe(204);
    expect(requestPasswordReset).toHaveBeenCalledWith('a@example.com');
    const foreign = await handlePasswordResetRequest(
      post(AUTH_PATHS.passwordResetRequest, { email: 'a@example.com' }, 'https://evil.example'),
      d,
    );
    expect(foreign.status).toBe(403);
    const bad = await handlePasswordResetRequest(
      post(AUTH_PATHS.passwordResetRequest, { email: 'nope' }),
      d,
    );
    expect(bad.status).toBe(400);
  });

  it('confirm: stores the new session in the cookies, or passes the API error on', async () => {
    const ok = await handlePasswordResetConfirm(
      post(AUTH_PATHS.passwordResetConfirm, { token: TOKEN, newPassword: NEW_PW }),
      deps({ confirmPasswordReset: () => Promise.resolve(tokens) }),
    );
    expect(ok.status).toBe(204);
    const cookies = ok.headers.getSetCookie().join('\n');
    expect(cookies).toContain(`${cookieNames(true).refresh}=`);

    const invalid = await handlePasswordResetConfirm(
      post(AUTH_PATHS.passwordResetConfirm, { token: TOKEN, newPassword: NEW_PW }),
      deps({
        confirmPasswordReset: () =>
          Promise.reject(
            new AuthProviderError('x', 400, ErrorCode.PASSWORD_RESET_INVALID, undefined),
          ),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: ErrorCode.PASSWORD_RESET_INVALID });
  });
});
