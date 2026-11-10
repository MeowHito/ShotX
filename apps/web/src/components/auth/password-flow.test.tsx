import { DRIVE_ROUTES, ErrorCode, ME_ROUTES, PHOTOGRAPHER_ACCOUNT_ROUTES } from '@shotx/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { BFF_KEY, FakeAuthApi } from '../../../test/fake-auth-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { StudioGate } from '@/components/studio/studio-gate';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { AUTH_PATHS, type AuthDeps } from '@/lib/auth/handlers';
import { handleChangePassword, handlePasswordSignIn } from '@/lib/auth/password';
import { cookieNames, decodeSession, jwtClaims } from '@/lib/auth/session';
import { createShotxAuthProvider, RefreshCache } from '@/lib/auth/shotx';
import { navigateTo } from '@/lib/browser/navigate';
import { useDriveUsage } from '@/lib/drive/queries';
import { th } from '@/messages/th';
import { AccountSettings } from '@/components/settings/account-settings';
import { ChangePasswordScreen } from './change-password-screen';
import { LoginButtons } from './login-buttons';

vi.mock('@/lib/browser/navigate', () => ({ navigateTo: vi.fn() }));
const navigate = vi.mocked(navigateTo);

const BASE = 'https://photos.example.com';
const names = cookieNames(true);
const EMAIL = 'somchai@example.com';
const TEMPORARY = 'Temp-4821-xq';
const CHOSEN = 'my-own-Secret-77';

/**
 * The browser side wired to web's real route handlers and the fake API behind them, with a cookie
 * jar standing in for the browser: what the forms send goes through handlePasswordSignIn and
 * handleChangePassword exactly as in production (same-origin, httpOnly cookies).
 */
function browser() {
  const api = new FakeAuthApi();
  const provider = createShotxAuthProvider({
    apiInternalUrl: 'http://api',
    client: { refreshReuseGraceSeconds: 10, callTimeoutMs: 15_000 },
    context: { bffKey: BFF_KEY, clientIp: '203.0.113.7' },
    fetch: (input, init) => api.fetch(input, init),
    devLogin: false,
    refreshCache: new RefreshCache(0, () => api.now),
  });
  const deps: AuthDeps = { provider, publicBaseUrl: BASE, secureCookies: true, now: () => api.now };
  const jar = new Map<string, string>();
  const sent: { path: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // The forms call same-origin paths with a JSON string body.
    const path = input as string;
    const body = init?.body as string;
    sent.push({ path, body: JSON.parse(body) as unknown });
    const request = new Request(`${BASE}${path}`, {
      method: init?.method,
      body,
      headers: {
        ...(init?.headers as Record<string, string>),
        origin: BASE,
        cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
      },
    });
    const handler =
      path === AUTH_PATHS.passwordSignIn
        ? handlePasswordSignIn
        : path === AUTH_PATHS.changePassword
          ? handleChangePassword
          : null;
    if (handler === null) return new Response(null, { status: 404 });
    const response = await handler(request, deps);
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ''] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (raw.includes('Max-Age=0')) jar.delete(name);
      else jar.set(name, decodeURIComponent(pair.slice(eq + 1)));
    }
    return response;
  };
  const session = () => decodeSession(jar.get(names.session));
  return { api, jar, fetch, sent, session };
}

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

async function fillChange(current: string, next: string, confirm = next) {
  const currentField = screen.getByLabelText(th.password.currentTemporary);
  const newField = screen.getByLabelText(th.password.newPassword);
  const confirmField = screen.getByLabelText(th.password.confirm);
  for (const field of [currentField, newField, confirmField]) await userEvent.clear(field);
  if (current) await userEvent.type(currentField, current);
  if (next) await userEvent.type(newField, next);
  if (confirm) await userEvent.type(confirmField, confirm);
  await userEvent.click(screen.getByRole('button', { name: th.password.submitRequired }));
}

beforeEach(() => {
  navigate.mockReset();
});

describe('sign-in → forced password change → studio (mobile-first forms)', () => {
  it('runs the whole flow through the real handlers', async () => {
    const b = browser();
    b.api.addPhotographer({ email: EMAIL, password: TEMPORARY, name: 'สมชาย' });

    // 1. Studio sign-in: email + password first, LINE/Google below it.
    const login = renderIntl(
      <LoginButtons
        options={{ password: true, oidc: ['line', 'google'], devLogin: false }}
        next="/studio/shares"
        fetch={b.fetch}
      />,
    );
    await userEvent.type(screen.getByLabelText(th.login.email), EMAIL);
    await userEvent.type(screen.getByLabelText(th.login.password), TEMPORARY);
    await userEvent.click(screen.getByRole('button', { name: th.login.submit }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/change-password?next=%2Fstudio%2Fshares'),
    );
    expect(b.sent[0]).toEqual({
      path: '/auth/sign-in',
      body: { email: EMAIL, password: TEMPORARY, next: '/studio/shares' },
    });
    // The cookies hold a restricted session; the browser JS never saw a token.
    expect(jwtClaims(b.session()?.accessToken).pwd_change).toBe(true);
    login.unmount();

    // 2. The forced change: client-side checks first, nothing sent.
    navigate.mockReset();
    renderIntl(
      <ChangePasswordScreen email={EMAIL} minLength={10} next="/studio/shares" fetch={b.fetch} />,
    );
    expect(screen.getByRole('heading', { name: th.password.requiredTitle })).toBeInTheDocument();
    expect(screen.getByText(/^อย่างน้อย 10 ตัวอักษร/)).toBeInTheDocument();
    const sentBefore = b.sent.length;

    await fillChange(TEMPORARY, 'short1!');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'รหัสผ่านใหม่ต้องมีอย่างน้อย 10 ตัวอักษร',
    );
    expect(screen.getByLabelText(th.password.newPassword)).toHaveAttribute('aria-invalid', 'true');

    await fillChange(TEMPORARY, 'aaaaaaaaaaaa');
    expect(screen.getByRole('alert')).toHaveTextContent(th.errors.passwordPolicy.too_simple);

    await fillChange(TEMPORARY, 'xx-somchai-2026');
    expect(screen.getByRole('alert')).toHaveTextContent(th.errors.passwordPolicy.contains_email);

    await fillChange(TEMPORARY, TEMPORARY);
    expect(screen.getByRole('alert')).toHaveTextContent(th.errors.passwordPolicy.same_as_current);

    await fillChange(TEMPORARY, CHOSEN, `${CHOSEN}x`);
    expect(screen.getByRole('alert')).toHaveTextContent(th.password.mismatch);

    await fillChange('', CHOSEN);
    expect(screen.getByRole('alert')).toHaveTextContent(th.password.currentMissing);
    expect(b.sent.length).toBe(sentBefore);

    // 3. The API refuses a wrong current password, in Thai.
    await fillChange('wrong-temp', CHOSEN);
    expect(await screen.findByText(th.errors.codes.PASSWORD_INCORRECT)).toBeInTheDocument();
    expect(screen.getByLabelText(th.password.currentTemporary)).toHaveValue('');
    expect(navigate).not.toHaveBeenCalled();

    // 4. The change: new normal session in the cookies, then on to where the person was going.
    await fillChange(TEMPORARY, CHOSEN);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/studio/shares'));
    expect(b.sent.at(-1)).toEqual({
      path: '/auth/password',
      body: { currentPassword: TEMPORARY, newPassword: CHOSEN },
    });
    expect(jwtClaims(b.session()?.accessToken).pwd_change).toBeUndefined();
    expect(b.api.familyOf(b.session()?.accessToken ?? '')?.restricted).toBe(false);
    expect(
      b.api.calls.filter((c) => c.route === PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword),
    ).toHaveLength(2);

    // 5. The studio opens normally.
    const studio = new FakeApi();
    renderWithProviders(
      <StudioGate onPasswordChangeRequired={() => navigate('/change-password')}>
        <p>studio content</p>
      </StudioGate>,
      { api: apiClientFor(studio.fetch) },
    );
    expect(await screen.findByText('studio content')).toBeInTheDocument();
  });

  it('shows server policy refusals with the API’s minimum length', async () => {
    const b = browser();
    b.api.passwordMinLength = 14;
    b.api.addPhotographer({ email: EMAIL, password: TEMPORARY });
    await b.fetch('/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: TEMPORARY }),
    });
    renderIntl(
      <ChangePasswordScreen email={EMAIL} minLength={10} next="/studio" fetch={b.fetch} />,
    );
    await fillChange(TEMPORARY, 'Sh0rter-pw!');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'รหัสผ่านใหม่ต้องมีอย่างน้อย 14 ตัวอักษร',
    );
    // The hint follows the API's minimum from now on.
    expect(screen.getByText(/^อย่างน้อย 14 ตัวอักษร/)).toBeInTheDocument();
  });

  it('says why a sign-in failed, in Thai, and keeps the email', async () => {
    const b = browser();
    b.api.addPhotographer({ email: EMAIL, password: CHOSEN, mustChange: false });
    b.api.addPhotographer({ email: 'off@example.com', password: CHOSEN, disabled: true });
    renderIntl(
      <LoginButtons
        options={{ password: true, oidc: [], devLogin: false }}
        next="/studio"
        fetch={b.fetch}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: th.login.submit }));
    expect(screen.getByRole('alert')).toHaveTextContent(th.login.errors.missing);
    expect(b.sent).toEqual([]);

    await userEvent.type(screen.getByLabelText(th.login.email), EMAIL);
    await userEvent.type(screen.getByLabelText(th.login.password), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: th.login.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(th.errors.codes.INVALID_CREDENTIALS);
    expect(screen.getByLabelText(th.login.email)).toHaveValue(EMAIL);
    expect(screen.getByLabelText(th.login.password)).toHaveValue('');

    await userEvent.clear(screen.getByLabelText(th.login.email));
    await userEvent.type(screen.getByLabelText(th.login.email), 'off@example.com');
    await userEvent.type(screen.getByLabelText(th.login.password), CHOSEN);
    await userEvent.click(screen.getByRole('button', { name: th.login.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(th.errors.codes.ACCOUNT_DISABLED);

    for (let i = 0; i < b.api.lockoutThreshold; i++) {
      await b.fetch('/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: 'nope' }),
      });
    }
    await userEvent.clear(screen.getByLabelText(th.login.email));
    await userEvent.type(screen.getByLabelText(th.login.email), EMAIL);
    await userEvent.type(screen.getByLabelText(th.login.password), CHOSEN);
    await userEvent.click(screen.getByRole('button', { name: th.login.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ส่งคำขอบ่อยเกินไป กรุณารออีก 15 นาทีแล้วลองใหม่',
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('a restricted session anywhere in the app', () => {
  function UsageProbe() {
    const usage = useDriveUsage();
    return <p>{usage.isError ? 'failed' : 'loading'}</p>;
  }

  it('goes to the change page when any call answers PASSWORD_CHANGE_REQUIRED', async () => {
    const fake = new FakeApi({ passwordChangeRequired: true });
    window.history.replaceState(null, '', '/studio/folders/abc?view=list');
    renderWithProviders(<UsageProbe />, { api: apiClientFor(fake.fetch) });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        '/change-password?next=%2Fstudio%2Ffolders%2Fabc%3Fview%3Dlist',
      ),
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(fake.callsTo(DRIVE_ROUTES.usage)).toHaveLength(1);
    window.history.replaceState(null, '', '/');
  });

  it('GET /me still answers, so the gate redirects before the drive loads', async () => {
    const fake = new FakeApi({ passwordChangeRequired: true });
    window.history.replaceState(null, '', '/studio');
    renderWithProviders(
      <StudioGate>
        <UsageProbe />
      </StudioGate>,
      { api: apiClientFor(fake.fetch) },
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/change-password?next=%2Fstudio'));
    expect(fake.callsTo(ME_ROUTES.get)).toHaveLength(1);
    expect(fake.callsTo(DRIVE_ROUTES.usage)).toHaveLength(0);
    expect(fake.me.passwordChangeRequired).toBe(true);
    expect(ErrorCode.PASSWORD_CHANGE_REQUIRED).toBe('PASSWORD_CHANGE_REQUIRED');
    window.history.replaceState(null, '', '/');
  });
});

describe('studio settings: เปลี่ยนรหัสผ่าน', () => {
  it('changes the password of a signed-in photographer and says other devices are signed out', async () => {
    const b = browser();
    b.api.addPhotographer({ email: EMAIL, password: CHOSEN, mustChange: false });
    await b.fetch('/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: CHOSEN }),
    });
    const before = b.jar.get(names.refresh);
    renderIntl(
      <AccountSettings
        user={{ name: 'สมชาย', email: EMAIL }}
        passwordAccount
        minLength={10}
        fetch={b.fetch}
      />,
    );
    const section = screen.getByRole('region', { name: th.password.title });
    await userEvent.type(within(section).getByLabelText(th.password.current), CHOSEN);
    await userEvent.type(
      within(section).getByLabelText(th.password.newPassword),
      'brand-New-Phrase-3',
    );
    await userEvent.type(within(section).getByLabelText(th.password.confirm), 'brand-New-Phrase-3');
    await userEvent.click(within(section).getByRole('button', { name: th.password.submit }));
    expect(await within(section).findByRole('status')).toHaveTextContent(th.password.done);
    expect(within(section).getByLabelText(th.password.current)).toHaveValue('');
    expect(b.jar.get(names.refresh)).not.toBe(before);
    expect(b.api.refreshTokenWorks(before ?? '')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('LINE/Google accounts have no password to change', () => {
    renderIntl(
      <AccountSettings
        user={{ name: 'LINE', email: null }}
        passwordAccount={false}
        minLength={10}
      />,
    );
    expect(screen.getByText(th.password.noPassword)).toBeInTheDocument();
    expect(screen.queryByLabelText(th.password.current)).toBeNull();
  });
});
