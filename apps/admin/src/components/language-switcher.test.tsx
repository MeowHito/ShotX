import { LOCALE_COOKIE } from '@shotx/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser } from '../../test/fake-admin-api';
import { urlOf } from '../../test/fetch';
import { renderWithProviders } from '../../test/render';
import { SignInFlow } from '@/components/auth/sign-in-flow';
import { AdminShell } from '@/components/shell/admin-shell';
import { UsersTable } from '@/components/users/users-table';
import { type Locale, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { localeCookie } from '@/lib/i18n/locale-cookie';
import { reloadPage } from '@/lib/i18n/navigate';
import { LanguageSwitcher } from './language-switcher';

vi.mock('@/lib/i18n/navigate', () => ({ reloadPage: vi.fn() }));
// The request config is a plain function outside a Next server.
vi.mock('next-intl/server', () => ({ getRequestConfig: (fn: unknown) => fn }));
const cookieStore = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'shotx_locale' && cookieStore.value !== undefined
          ? { value: cookieStore.value }
          : undefined,
    }),
}));

afterEach(() => {
  document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
  vi.mocked(reloadPage).mockClear();
  cookieStore.value = undefined;
});

function withLocale(locale: Locale, ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone={TIME_ZONE}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('admin language switcher', () => {
  it('offers ไทย / English / 中文, stores the choice in LOCALE_COOKIE and reloads', async () => {
    withLocale('th', <LanguageSwitcher />);
    const group = screen.getByRole('group', { name: 'ภาษา' });
    const thai = within(group).getByRole('button', { name: 'ไทย' });
    expect(thai).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: '中文' })).toHaveAttribute('lang', 'zh-Hans');

    await userEvent.click(within(group).getByRole('button', { name: 'English' }));
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=en`);
    expect(reloadPage).toHaveBeenCalledTimes(1);
    // The current language does nothing.
    await userEvent.click(thai);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('writes the same year-long, path-wide, host-only cookie as the web app', () => {
    expect(localeCookie('zh', true)).toBe(
      `${LOCALE_COOKIE}=zh; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(localeCookie('en', false)).toBe(
      `${LOCALE_COOKIE}=en; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
    expect(localeCookie('th', true)).not.toMatch(/Domain=/i);
  });

  it('the server reads the choice back on every request, Thai for anything unknown', async () => {
    const { default: requestConfig } = await import('@/i18n/request');
    const config = requestConfig as unknown as () => Promise<{
      locale: string;
      messages: unknown;
      timeZone: string;
    }>;
    cookieStore.value = 'zh';
    await expect(config()).resolves.toEqual({
      locale: 'zh',
      messages: MESSAGES.zh,
      timeZone: 'Asia/Bangkok',
    });
    cookieStore.value = 'en';
    await expect(config()).resolves.toMatchObject({ locale: 'en', messages: MESSAGES.en });
    for (const unknown of ['fr', 'EN', 'th-TH', '', '../en', 'zh; Domain=evil']) {
      cookieStore.value = unknown;
      await expect(config()).resolves.toMatchObject({ locale: 'th', messages: MESSAGES.th });
    }
    cookieStore.value = undefined;
    await expect(config()).resolves.toMatchObject({ locale: 'th', messages: MESSAGES.th });
  });

  it('is in the signed-in frame, next to sign out, in the current language', async () => {
    withLocale(
      'zh',
      <AdminShell pathname="/users" user={{ id: 'x', email: 'me@example.com', name: null }}>
        <p>content</p>
      </AdminShell>,
    );
    const group = screen.getByRole('group', { name: '语言' });
    expect(within(group).getByRole('button', { name: '中文' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '用户' })).toHaveAttribute('href', '/users');
    await userEvent.click(within(group).getByRole('button', { name: 'ไทย' }));
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=th`);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('formats storage, bytes and dates in the UI language (times in Asia/Bangkok)', () => {
    const user = makeUser({
      email: 'photo@example.com',
      usedBytes: 1234.5 * 1024 ** 3,
      lastSignInAt: '2026-11-09T17:30:00.000Z',
    });
    const view = renderWithProviders(
      <UsersTable users={[user]} currentAdminId={null} now={0} onAction={vi.fn()} />,
      { fetch: vi.fn(), locale: 'en' },
    );
    expect(screen.getByRole('columnheader', { name: 'Storage used' })).toBeInTheDocument();
    expect(screen.getByText('Photographer')).toBeInTheDocument();
    expect(screen.getByText('1,235 GB')).toHaveAttribute('title', '1,325,534,281,728 B');
    // 17:30 UTC on 9 Nov is 00:30 on 10 Nov in Bangkok; en-GB, not the Buddhist calendar.
    expect(screen.getByText('10 Nov 2026, 00:30')).toBeInTheDocument();
    view.unmount();

    renderWithProviders(
      <UsersTable users={[user]} currentAdminId={null} now={0} onAction={vi.fn()} />,
      { fetch: vi.fn(), locale: 'zh' },
    );
    expect(screen.getByText('摄影师')).toBeInTheDocument();
    expect(screen.getByText('2026年11月10日 00:30')).toBeInTheDocument();
  });

  it('on the sign-in page, only on the email + password step (a reload restarts sign-in)', async () => {
    const user = userEvent.setup();
    const uri =
      'otpauth://totp/ShotX:a%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ShotX&digits=6&period=30';
    const answers: Record<string, unknown[]> = {
      '/auth/login': [
        { step: 'enrol_totp', otpauthUri: uri },
        { step: 'totp' },
        { step: 'change_password' },
      ],
    };
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      const path = urlOf(input);
      return Promise.resolve(
        new Response(JSON.stringify(answers[path]?.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    renderWithProviders(
      <SignInFlow
        next="/users"
        fetchImpl={fetchImpl}
        onSignedIn={vi.fn()}
        languageSwitcher={<LanguageSwitcher />}
      />,
      { fetch: fetchImpl },
    );
    const switcher = () => screen.queryByRole('group', { name: 'ภาษา' });
    async function signIn() {
      expect(switcher()).toBeInTheDocument();
      await user.type(screen.getByLabelText('อีเมล'), 'a@example.com');
      await user.type(screen.getByLabelText('รหัสผ่าน'), 'password-1234567');
      await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    }

    await signIn();
    expect(
      await screen.findByRole('heading', { name: 'ตั้งค่าแอปยืนยันตัวตน' }),
    ).toBeInTheDocument();
    expect(switcher()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'เริ่มใหม่' }));

    await signIn();
    expect(await screen.findByRole('heading', { name: 'ยืนยันตัวตน' })).toBeInTheDocument();
    expect(switcher()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'เริ่มใหม่' }));

    await signIn();
    expect(await screen.findByRole('heading', { name: 'ตั้งรหัสผ่านใหม่' })).toBeInTheDocument();
    expect(switcher()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'เริ่มใหม่' }));
    expect(switcher()).toBeInTheDocument();
  });
});
