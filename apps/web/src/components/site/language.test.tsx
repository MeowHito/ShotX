import { LOCALE_COOKIE } from '@shotx/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { fakeNavigator, renderSharePage } from '../../../test/share-harness';
import { MESSAGES, TIME_ZONE } from '@/i18n/config';
import { reloadPage } from '@/lib/browser/navigate';
import { localeCookie } from '@/lib/i18n/locale-cookie';
import { PublicTopBar } from './public-top-bar';
import { DRIVE_ROOT } from '@shotx/shared';
import { within } from '@testing-library/react';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { DriveBrowser } from '@/components/drive/drive-browser';
import { AccountMenu } from '@/components/studio/account-menu';
import { StorageMeter } from '@/components/studio/storage-meter';
import { describeError } from '@/lib/errors/messages';
import { ApiError } from '@/lib/api/errors';

vi.mock('@/lib/browser/navigate', () => ({ reloadPage: vi.fn(), navigateTo: vi.fn() }));
vi.mock('photoswipe', () => ({ default: class {} }));
// The request config is a plain function outside a Next server.
vi.mock('next-intl/server', () => ({ getRequestConfig: (fn: unknown) => fn }));
const cookieStore = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: () => (cookieStore.value === undefined ? undefined : { value: cookieStore.value }),
    }),
}));

beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 960 });
});

afterEach(() => {
  document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
  vi.mocked(reloadPage).mockClear();
});

function bar(locale: 'th' | 'en' | 'zh') {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone={TIME_ZONE}>
      <PublicTopBar />
    </NextIntlClientProvider>,
  );
}

describe('language switcher (ADR 0011)', () => {
  it('offers ไทย / English / 中文, stores the choice in LOCALE_COOKIE and reloads', async () => {
    bar('th');
    const thai = screen.getByRole('button', { name: 'ไทย' });
    expect(thai).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '中文' })).toHaveAttribute('lang', 'zh');
    expect(screen.getByRole('link', { name: /หน้าแรก/ })).toHaveAttribute('href', '/');

    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=en`);
    expect(reloadPage).toHaveBeenCalledTimes(1);
    // The current language does nothing.
    await userEvent.click(thai);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('writes a year-long, site-wide cookie (Secure on https)', () => {
    expect(localeCookie('zh', true)).toBe(
      `${LOCALE_COOKIE}=zh; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(localeCookie('en', false)).not.toContain('Secure');
  });

  it('the server reads the choice back on every request, Thai by default', async () => {
    const { default: requestConfig } = await import('@/i18n/request');
    const config = requestConfig as unknown as () => Promise<{ locale: string; messages: unknown }>;
    cookieStore.value = 'zh';
    await expect(config()).resolves.toMatchObject({ locale: 'zh', messages: MESSAGES.zh });
    cookieStore.value = 'fr';
    await expect(config()).resolves.toMatchObject({ locale: 'th' });
    cookieStore.value = undefined;
    await expect(config()).resolves.toMatchObject({ locale: 'th', messages: MESSAGES.th });
  });

  it('shows the share page and the consent in English, and records the locale with the consent', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ faceSearchAvailable: true });
    renderSharePage(fake, share.token, { locale: 'en', nav: fakeNavigator().nav });
    await userEvent.click(await screen.findByRole('button', { name: 'Find me by face' }));
    expect(screen.getByRole('heading', { name: 'Find your photos by face' })).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.en.consent.translationNote)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'I agree to the use of my face photo to find my photos',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Accept and start' }));
    expect(await screen.findByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    expect(share.consentLocales).toEqual(['en']);
  });

  it('the studio is translated too: drive, menus and the storage meter in English and Chinese', async () => {
    const fake = new FakeApi({ quotaBytes: null, usedBytes: 1.5 * 1024 ** 3 });
    fake.addFolder('Event');
    renderWithProviders(
      <>
        <DriveBrowser folderRef={DRIVE_ROOT} />
        <StorageMeter />
      </>,
      { api: apiClientFor(fake.fetch), locale: 'en' },
    );
    expect(await screen.findByRole('button', { name: 'Options for Event' })).toBeInTheDocument();
    expect(await screen.findByText('1.5 GB used')).toBeInTheDocument();
  });

  it('the studio account menu switches the language too', async () => {
    const fake = new FakeApi();
    renderWithProviders(<AccountMenu user={{ name: 'Somchai', email: null }} />, {
      api: apiClientFor(fake.fetch),
      locale: 'zh',
    });
    await userEvent.click(screen.getByRole('button', { name: '账号菜单' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '中文' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'English' }));
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=en`);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('formats sizes and times in the UI language (Intl)', () => {
    const error = new ApiError(422, 'FILE_TOO_LARGE', 'x', { maxBytes: 1.5 * 1024 ** 3 });
    expect(describeError(error, { subscriptionStatus: (s) => s, locale: 'en-GB' }).values).toEqual({
      max: '1.5 GB',
    });
    // German-style decimals would show a comma; Thai, English and Chinese all use a point.
    expect(describeError(error, { subscriptionStatus: (s) => s, locale: 'de-DE' }).values).toEqual({
      max: '1,5 GB',
    });
  });
});
