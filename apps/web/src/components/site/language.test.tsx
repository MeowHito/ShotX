import { HTML_LANG } from '@/i18n/config';
import { LOCALE_COOKIE } from '@shotx/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { fakeNavigator, goodFace, renderSharePage } from '../../../test/share-harness';
import { MESSAGES, TIME_ZONE } from '@/i18n/config';
import { reloadPage } from '@/lib/browser/navigate';
import { localeCookie } from '@/lib/i18n/locale-cookie';
import { PublicTopBar } from './public-top-bar';
import { DRIVE_ROOT, LATEST_CONSENT_POLICY_VERSION } from '@shotx/shared';
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
  URL.createObjectURL = () => 'blob:selfie';
  URL.revokeObjectURL = () => undefined;
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
  it('is one compact menu button: the current flag (no short text), a 44px target', () => {
    bar('th');
    const nav = screen.getByRole('navigation', { name: MESSAGES.th.publicNav.label });
    expect(within(nav).getByRole('link', { name: /หน้าแรก/ })).toHaveAttribute('href', '/');
    const button = within(nav).getByRole('button', { name: 'ภาษา ไทย' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveClass('h-11', 'min-w-11', 'shrink-0');
    // Owner feedback 2026-11-12: no frame around the button.
    expect(button).not.toHaveClass('border');
    // Owner feedback 2026-11-12: a flag instead of "TH".
    expect(within(button).getByTestId('flag-th')).toHaveAttribute('aria-hidden', 'true');
    expect(button).not.toHaveTextContent(/TH/);
    // Nothing else in the bar: no row of language buttons any more.
    expect(within(nav).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it.each([
    ['en', 'Language English'],
    ['zh', '语言 中文'],
  ] as const)('%s: the button is named from the messages (%s)', (locale, name) => {
    bar(locale);
    const button = screen.getByRole('button', { name });
    expect(button.querySelector('[lang]')).toHaveAttribute('lang', HTML_LANG[locale]);
    expect(within(button).getByTestId(`flag-${locale}`)).toBeInTheDocument();
  });

  it('opens a menu of ไทย / English / 中文, each in its own script, the current one checked', async () => {
    bar('th');
    const button = screen.getByRole('button', { name: 'ภาษา ไทย' });
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['ไทย', 'English', '中文']);
    expect(items.map((i) => i.getAttribute('lang'))).toEqual(['th', 'en', 'zh-Hans']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(
      items.map((i) => i.querySelector<SVGElement>('[data-testid^="flag-"]')?.dataset.testid),
    ).toEqual(['flag-th', 'flag-en', 'flag-zh']);
  });

  it('choosing a language writes LOCALE_COOKIE and reloads; the current one does nothing', async () => {
    bar('th');
    await userEvent.click(screen.getByRole('button', { name: 'ภาษา ไทย' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'English' }));
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=en`);
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'ภาษา ไทย' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'ไทย' }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('works from the keyboard, and Escape closes the menu back to the button', async () => {
    bar('en');
    const button = screen.getByRole('button', { name: 'Language English' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    expect(reloadPage).not.toHaveBeenCalled();

    // Arrow keys move through the languages; Enter chooses.
    await userEvent.keyboard('{ArrowDown}');
    const chinese = await screen.findByRole('menuitemradio', { name: '中文' });
    while (document.activeElement !== chinese) await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh`);
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

  it.each(['en', 'zh'] as const)(
    '%s: share page, face search, results and downloads show no Thai, labels included',
    async (locale) => {
      const m = MESSAGES[locale];
      const noThai = () => {
        expect(document.body.textContent).not.toMatch(/[\u0E00-\u0E7F]/);
        for (const el of document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')) {
          const label = ['aria-label', 'title', 'alt', 'placeholder']
            .map((a) => el.getAttribute(a) ?? '')
            .join(' ');
          expect(label, el.outerHTML.slice(0, 120)).not.toMatch(/[\u0E00-\u0E7F]/);
        }
      };
      const fake = new FakeApi({ faceSearch: true });
      const share = fake.addPublicShare({ faceSearchAvailable: true, itemCount: 4 });
      const [a, b, c] = share.items;
      share.faceMatches = { strong: [a?.id ?? '', b?.id ?? ''], maybe: [c?.id ?? ''] };
      const { scenario } = renderSharePage(fake, share.token, {
        locale,
        nav: fakeNavigator().nav,
      });
      await screen.findByRole('list', { name: m.share.galleryLabel });
      expect(
        screen.getByRole('button', {
          name: `${m.publicNav.language} ${m.publicNav.locales[locale]}`,
        }),
      ).toBeInTheDocument();
      noThai();

      await userEvent.click(screen.getByRole('button', { name: m.share.scan }));
      noThai();
      const policy = m.consent.policies.face_search[LATEST_CONSENT_POLICY_VERSION];
      await userEvent.click(screen.getByRole('checkbox', { name: policy.checkbox }));
      await userEvent.click(screen.getByRole('button', { name: m.consent.accept }));

      // A refused shot: a short statement in the UI language.
      scenario.faces = [];
      const take = await screen.findByRole('button', { name: m.capture.takePhoto });
      await waitFor(() => expect(take).toBeEnabled());
      await userEvent.click(take);
      expect(await screen.findByText(m.capture.issues.noFace)).toBeInTheDocument();
      noThai();

      scenario.faces = [goodFace()];
      const again = await screen.findByRole('button', { name: m.capture.takePhoto });
      await waitFor(() => expect(again).toBeEnabled());
      await userEvent.click(again);
      await screen.findByRole('region', { name: m.results.strong });
      expect(screen.getByRole('region', { name: m.results.maybe })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: m.results.selectAll })).toBeInTheDocument();
      noThai();

      // Select all found: the download bar.
      await userEvent.click(screen.getByRole('button', { name: m.results.selectAll }));
      expect(await screen.findByRole('button', { name: m.downloads.clear })).toBeInTheDocument();
      noThai();
    },
  );

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
