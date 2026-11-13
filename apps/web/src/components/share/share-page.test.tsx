import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ME_ROUTES, PUBLIC_SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeApi, shareItem } from '../../../test/fake-api';
import { fakeNavigator, renderSharePage } from '../../../test/share-harness';
import { MESSAGES } from '@/i18n/config';
import { th } from '@/messages/th';

const photoswipe = vi.hoisted(() => ({
  instances: [] as Record<string, unknown>[],
  elements: [] as Record<string, unknown>[],
  doms: [] as { element: HTMLElement; scrollWrap: HTMLElement; holders: HTMLElement[] }[],
}));
vi.mock('photoswipe', () => ({
  default: class {
    ui = { registerElement: (el: Record<string, unknown>) => photoswipe.elements.push(el) };
    currIndex = 0;
    element?: HTMLElement;
    scrollWrap?: HTMLElement;
    mainScroll = { itemHolders: [] as { el: HTMLElement }[] };
    private handlers = new Map<string, () => void>();
    constructor(options: Record<string, unknown>) {
      photoswipe.instances.push(options);
      this.currIndex = options.index as number;
    }
    on(name: string, fn: () => void) {
      this.handlers.set(name, fn);
    }
    init() {
      // Like PhotoSwipe: the dialog, the carousel and three slide holders, in English.
      this.element = document.createElement('div');
      this.element.setAttribute('role', 'dialog');
      this.scrollWrap = document.createElement('section');
      this.scrollWrap.setAttribute('aria-roledescription', 'carousel');
      const holders = [0, 1, 2].map(() => {
        const el = document.createElement('div');
        el.setAttribute('aria-roledescription', 'slide');
        return el;
      });
      this.mainScroll.itemHolders = holders.map((el) => ({ el }));
      photoswipe.doms.push({ element: this.element, scrollWrap: this.scrollWrap, holders });
      this.handlers.get('uiRegister')?.();
    }
    destroy() {}
  },
}));

function resetPhotoswipe() {
  photoswipe.instances.length = 0;
  photoswipe.elements.length = 0;
  photoswipe.doms.length = 0;
}

beforeAll(() => {
  // jsdom has no media playback.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  // The scan flow (results lightbox test): object URLs and a front camera frame.
  URL.createObjectURL = () => 'blob:selfie';
  URL.revokeObjectURL = () => undefined;
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 960 });
});

describe('share page: states', () => {
  it('layout (ADR 0011, 0015): top bar, centered title, no cover, photographer or count', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ itemCount: 3, faceSearchAvailable: true });
    renderSharePage(fake, share.token);

    const title = await screen.findByRole('heading', { name: share.title, level: 1 });
    expect(title.parentElement).toHaveClass('text-center');
    const nav = screen.getByRole('navigation', { name: th.publicNav.label });
    // No design: the usual solid, sticky bar.
    expect(nav.closest('header')).not.toHaveAttribute('data-overlay');
    expect(within(nav).getByRole('link', { name: /หน้าแรก/ })).toHaveAttribute('href', '/');
    expect(
      within(nav).getByRole('button', { name: new RegExp(th.publicNav.language) }),
    ).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByTestId('share-cover')).toBeNull();
    expect(screen.queryByText(/ถ่ายโดย/)).not.toBeInTheDocument();
    expect(screen.queryByText(/3 รูป/)).not.toBeInTheDocument();

    // The sticky face-search button, safe-area aware at the bottom, raised above a macOS Dock on
    // wider screens (ADR 0015).
    const scan = screen.getByRole('button', { name: th.share.scan });
    expect(scan.parentElement).toHaveClass('fixed', 'bottom-0', 'sm:pb-24');
    expect(scan.parentElement?.className).toContain('safe-area-inset-bottom');

    // No link to "delete my face" anywhere (ADR 0011 decision 2), not even the studio's copy action.
    expect(document.querySelector('a[href*="delete-my-face"]')).toBeNull();
    expect(screen.queryByRole('button', { name: th.shares.copyDeletionLink })).toBeNull();

    const grid = await screen.findByRole('list', { name: th.share.galleryLabel });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(3);
    const publicCalls = fake.calls.filter((c) => c.path.startsWith('/s/'));
    expect(publicCalls.length).toBeGreaterThan(0);
    for (const call of publicCalls) {
      expect(call.prefix).toBe('/api');
      expect(call.credentials).toBe('include');
    }
  });

  it('ADR 0020: new photos appear at the top on their own, with no reload or spinner', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 3 });
    renderSharePage(fake, share.token, { shareConfig: { livePollMs: 40 } });
    const grid = await screen.findByRole('list', { name: th.share.galleryLabel });
    await waitFor(() => expect(within(grid).getAllByRole('listitem')).toHaveLength(3));
    // Unchanged: the page only asks for the version, it doesn't refetch the photos.
    await waitFor(() =>
      expect(fake.callsTo(PUBLIC_SHARE_ROUTES.changes).length).toBeGreaterThanOrEqual(2),
    );
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.items)).toHaveLength(1);

    // The photographer uploads during the event: newest first, so it lands at the top.
    share.items.unshift(shareItem('new.jpg'));
    await waitFor(() => expect(within(grid).getAllByRole('listitem')).toHaveLength(4));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(th.share.loadingMore)).toBeNull();
  });

  it('opens by slug, then makes every other call with the token and shows the slug URL', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ title: 'งานวิ่ง กรุงเทพ 2026', itemCount: 2 });
    window.history.replaceState(null, '', `/s/${share.token}`);
    renderSharePage(fake, share.slug ?? '');
    await screen.findByRole('list', { name: th.share.galleryLabel });
    const metaCall = fake.callsTo(PUBLIC_SHARE_ROUTES.meta)[0];
    expect(metaCall?.path).toBe(`/s/${encodeURIComponent(share.slug ?? '')}`);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.items)[0]?.path).toBe(`/s/${share.token}/items`);
    expect(fake.refKinds[0]).toBe('slug');
    expect(fake.refKinds.slice(1).every((k) => k === 'token')).toBe(true);
    // The canonical (slug) URL replaces an old token URL, without a reload.
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/${encodeURIComponent(share.slug ?? '')}`),
    );
    window.history.replaceState(null, '', '/');
  });

  it('opens PhotoSwipe on the tapped photo with Thai labels', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 3 });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: 'เปิดดู IMG_0002.jpg' }));
    await waitFor(() => expect(photoswipe.instances).toHaveLength(1));
    const options = photoswipe.instances[0] as {
      index: number;
      dataSource: { src: string }[];
      closeTitle: string;
    };
    expect(options.index).toBe(1);
    expect(options.dataSource.map((s) => s.src)).toEqual(share.items.map((i) => i.previewUrl));
    expect(options.closeTitle).toBe(th.lightbox.close);
  });

  it('lightbox: previous/next arrows and a bottom download button for the current photo', async () => {
    const startDownload = vi.fn();
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 3 });
    photoswipe.instances.length = 0;
    photoswipe.elements.length = 0;
    const view = renderSharePage(fake, share.token);
    view.startDownload.mockImplementation(startDownload);
    await userEvent.click(await screen.findByRole('button', { name: 'เปิดดู IMG_0002.jpg' }));
    await waitFor(() => expect(photoswipe.instances).toHaveLength(1));
    expect(photoswipe.instances[0]).toMatchObject({
      arrowPrev: true,
      arrowNext: true,
      arrowPrevTitle: th.lightbox.prev,
      arrowNextTitle: th.lightbox.next,
    });
    const button = photoswipe.elements.find((e) => e.name === 'download') as {
      appendTo: string;
      order: number;
      className: string;
      html: string;
      onClick: () => void;
    };
    // The top bar, before zoom and close (owner, 2026-11-13).
    expect(button).toMatchObject({ appendTo: 'bar', order: 9, className: 'pswp__download' });
    expect(button.html).toContain(th.lightbox.downloadShort);
    button.onClick();
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.downloads)[0]?.body).toEqual({
      fileIds: [share.items[1]?.id],
    });
  });

  it('lightbox on iOS: "save to Photos" opens the share sheet with the photo fetched ahead', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 3 });
    resetPhotoswipe();
    const ios = fakeNavigator({ share: true });
    const view = renderSharePage(fake, share.token, { nav: ios.nav });
    await userEvent.click(await screen.findByRole('button', { name: 'เปิดดู IMG_0002.jpg' }));
    await waitFor(() => expect(photoswipe.instances).toHaveLength(1));
    // The photo on screen is fetched as soon as it shows, before any tap.
    await waitFor(() => expect(view.mediaFetch).toHaveBeenCalledTimes(1));
    const button = photoswipe.elements.find((e) => e.name === 'download') as {
      title: string;
      html: string;
      onInit: (el: HTMLElement) => void;
      onClick: () => void;
    };
    expect(button.title).toBe(th.lightbox.save);
    expect(button.html).toContain(th.lightbox.saveShort);
    const el = document.createElement('button');
    button.onInit(el);
    button.onClick();
    expect(ios.share).toHaveBeenCalledTimes(1);
    const files = ios.share.mock.calls[0]?.[0].files ?? [];
    expect(files.map((f) => f.name)).toEqual(['IMG_0002.jpg']);
    await waitFor(() => expect(el.textContent).toBe(th.lightbox.saved));
    // Never a plain download, which on iOS only reaches the Files app.
    expect(view.startDownload).not.toHaveBeenCalled();
  });

  it('lightbox on iOS: a tap Safari let expire asks for one more tap', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 1 });
    resetPhotoswipe();
    const ios = fakeNavigator({ share: true });
    ios.share.mockRejectedValueOnce(
      Object.assign(new Error('gesture'), { name: 'NotAllowedError' }),
    );
    const view = renderSharePage(fake, share.token, { nav: ios.nav });
    await userEvent.click(await screen.findByRole('button', { name: 'เปิดดู IMG_0001.jpg' }));
    await waitFor(() => expect(view.mediaFetch).toHaveBeenCalledTimes(1));
    const button = photoswipe.elements.find((e) => e.name === 'download') as {
      onInit: (el: HTMLElement) => void;
      onClick: () => void;
    };
    const el = document.createElement('button');
    button.onInit(el);
    button.onClick();
    await waitFor(() => expect(el.textContent).toBe(th.lightbox.tapAgain));
    button.onClick();
    await waitFor(() => expect(el.textContent).toBe(th.lightbox.saved));
    expect(ios.share).toHaveBeenCalledTimes(2);
    expect(view.mediaFetch).toHaveBeenCalledTimes(1);
  });

  it('shows photos in their own aspect ratio (justified rows, no square crop)', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({
      items: [
        shareItem('wide.jpg', { width: 6000, height: 4000 }),
        shareItem('tall.jpg', { width: 3000, height: 4500 }),
        shareItem('pano.jpg', { width: 8000, height: 2000 }),
      ],
    });
    renderSharePage(fake, share.token);
    const grid = await screen.findByRole('list', { name: th.share.galleryLabel });
    const cells = within(grid).getAllByRole('listitem');
    const ratios = cells.map((cell) => {
      const width = Number.parseFloat(cell.style.width);
      const height = Number.parseFloat((cell.querySelector('button') as HTMLElement).style.height);
      return width / height;
    });
    expect(ratios[0]).toBeCloseTo(1.5, 2);
    expect(ratios[1]).toBeCloseTo(2 / 3, 2);
    expect(ratios[2]).toBeCloseTo(4, 2);
    expect(cells[0]?.className).not.toContain('aspect-square');
  });

  it.each(['revoked', 'expired', 'unavailable'] as const)(
    'shows "ลิงก์นี้หมดอายุ" for SHARE_EXPIRED (%s)',
    async (reason) => {
      const fake = new FakeApi();
      const share = fake.addPublicShare({ expiredReason: reason });
      renderSharePage(fake, share.token);
      expect(await screen.findByRole('heading', { name: 'ลิงก์นี้หมดอายุ' })).toBeInTheDocument();
      expect(screen.getByText(th.share.unavailable.reasons[reason])).toBeInTheDocument();
      // ADR 0011 decision 2: no link to "delete my face" (the page stays, unlinked).
      expect(document.querySelector('a[href*="delete-my-face"]')).toBeNull();
    },
  );

  it('asks for the password and unlocks', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ password: 'run2026' });
    renderSharePage(fake, share.token);
    const input = await screen.findByLabelText(th.share.password.label);
    await userEvent.type(input, 'wrong');
    await userEvent.click(screen.getByRole('button', { name: th.share.password.submit }));
    expect(await screen.findByText('รหัสผ่านไม่ถูกต้อง')).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, 'run2026');
    await userEvent.click(screen.getByRole('button', { name: th.share.password.submit }));
    expect(await screen.findByRole('heading', { name: share.title })).toBeInTheDocument();
    const unlock = fake.callsTo(PUBLIC_SHARE_ROUTES.unlock);
    expect(unlock.at(-1)).toMatchObject({ prefix: '/api', body: { password: 'run2026' } });
  });

  it('login required, signed out: offers LINE and Google sign-in that return to the share', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ requireLogin: true });
    renderSharePage(fake, share.token, { signedIn: false });
    const line = await screen.findByRole('link', { name: th.share.login.line });
    // Back to the canonical (slug) page after signing in.
    const next = encodeURIComponent(`/${share.slug ?? ''}`);
    expect(line).toHaveAttribute('href', `/auth/login?provider=line&next=${next}`);
    expect(screen.getByRole('link', { name: th.share.login.google })).toHaveAttribute(
      'href',
      `/auth/login?provider=google&next=${next}`,
    );
    expect(fake.callsTo(ME_ROUTES.createViewerSession)).toHaveLength(0);
  });

  it('login required, only Google configured: offers Google only', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ requireLogin: true });
    renderSharePage(fake, share.token, { viewerLogin: { oidc: ['google'], devLogin: false } });
    expect(await screen.findByRole('link', { name: th.share.login.google })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: th.share.login.line })).toBeNull();
  });

  it('login required but no viewer sign-in at all: says to contact the photographer, no buttons', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ requireLogin: true });
    renderSharePage(fake, share.token, { viewerLogin: { oidc: [], devLogin: false } });
    expect(
      await screen.findByRole('heading', { name: th.share.login.unavailableTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(th.share.login.unavailableBody)).toHaveTextContent('ติดต่อช่างภาพ');
    expect(screen.queryByRole('link', { name: th.share.login.line })).toBeNull();
    expect(screen.queryByRole('link', { name: th.share.login.google })).toBeNull();
    expect(screen.queryByRole('heading', { name: th.share.login.title })).toBeNull();
  });

  it('login required with only the dev login (local): links to the sign-in page', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ requireLogin: true });
    renderSharePage(fake, share.token, { viewerLogin: { oidc: [], devLogin: true } });
    expect(await screen.findByRole('link', { name: th.share.login.devLogin })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/${share.slug ?? ''}`)}`,
    );
  });

  it('login required, signed in: creates the viewer session through the BFF, then shows photos', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ requireLogin: true });
    renderSharePage(fake, share.token, { signedIn: true });
    expect(await screen.findByRole('heading', { name: share.title })).toBeInTheDocument();
    const created = fake.callsTo(ME_ROUTES.createViewerSession);
    expect(created).toHaveLength(1);
    expect(created[0]?.prefix).toBe('/bff');
  });

  it('face_only: no cover or count, an intro to scan, and no photos before scanning', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ mode: 'face_only', faceSearchAvailable: true });
    renderSharePage(fake, share.token);
    expect(await screen.findByText(th.share.faceOnly.body)).toBeInTheDocument();
    expect(screen.queryByText('3 รูป')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: th.share.scan })).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo(PUBLIC_SHARE_ROUTES.items)).toHaveLength(1));
    expect(screen.queryByRole('list', { name: th.share.galleryLabel })).not.toBeInTheDocument();
  });

  it('flag off: no scan button, no consent, no face links', async () => {
    const fake = new FakeApi({ faceSearch: false });
    const share = fake.addPublicShare({ faceSearchAvailable: false });
    renderSharePage(fake, share.token);
    await screen.findByRole('list', { name: th.share.galleryLabel });
    expect(screen.queryByRole('button', { name: th.share.scan })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ถอนความยินยอม/ })).toBeNull();
    expect(document.querySelector('a[href*="delete-my-face"]')).toBeNull();
    // face_only without face search can't show anything; it says so instead of offering a scan.
    const faceOnly = fake.addPublicShare({ mode: 'face_only', faceSearchAvailable: false });
    renderSharePage(fake, faceOnly.token);
    expect(await screen.findByText(th.share.faceOnly.unavailable)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: th.share.scan })).not.toBeInTheDocument();
  });

  it('hides selection and downloads when the share disallows them', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ allowDownload: false });
    renderSharePage(fake, share.token);
    await screen.findByRole('list', { name: th.share.galleryLabel });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('lightbox (ADR 0011, owner feedback 2026-11-12)', () => {
  beforeEach(resetPhotoswipe);

  async function scanAndShowResults() {
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    const take = await screen.findByRole('button', { name: th.capture.takePhoto });
    await waitFor(() => expect(take).toBeEnabled());
    await userEvent.click(take);
    return screen.findByRole('region', { name: th.results.strong });
  }

  it('face-search results open the same lightbox: arrows, swipe list and the bottom download', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ faceSearchAvailable: true, itemCount: 5 });
    const [a, b, c] = share.items;
    share.faceMatches = { strong: [a?.id ?? '', b?.id ?? ''], maybe: [c?.id ?? ''] };
    const view = renderSharePage(fake, share.token);
    const strong = await scanAndShowResults();
    await userEvent.click(within(strong).getByRole('button', { name: `เปิดดู ${b?.name}` }));
    await waitFor(() => expect(photoswipe.instances).toHaveLength(1));
    const options = photoswipe.instances[0] as { index: number; dataSource: { src: string }[] };
    // The group's photos only, so swiping and the arrows stay within the results.
    expect(options.dataSource.map((x) => x.src)).toEqual([a?.previewUrl, b?.previewUrl]);
    expect(options).toMatchObject({ index: 1, arrowPrev: true, arrowNext: true });
    const button = photoswipe.elements.find((e) => e.name === 'download') as {
      onClick: () => void;
    };
    button.onClick();
    await waitFor(() => expect(view.startDownload).toHaveBeenCalledTimes(1));
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.downloads)[0]?.body).toEqual({ fileIds: [b?.id] });
  });

  it('no bottom download when the share disallows downloads (arrows stay)', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 3, allowDownload: false });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: 'เปิดดู IMG_0001.jpg' }));
    await waitFor(() => expect(photoswipe.instances).toHaveLength(1));
    expect(photoswipe.instances[0]).toMatchObject({ arrowPrev: true, arrowNext: true });
    expect(photoswipe.elements.find((e) => e.name === 'download')).toBeUndefined();
  });

  it.each(['en', 'zh'] as const)(
    '%s: every PhotoSwipe title, label and message comes from the messages, none Thai',
    async (locale) => {
      const m = MESSAGES[locale];
      const fake = new FakeApi();
      const share = fake.addPublicShare({ itemCount: 3 });
      renderSharePage(fake, share.token, { locale });
      const open = await screen.findByRole('button', {
        name: m.share.open.replace('{name}', 'IMG_0001.jpg'),
      });
      await userEvent.click(open);
      await waitFor(() => expect(photoswipe.instances).toHaveLength(1));
      const options = photoswipe.instances[0] as Record<string, unknown>;
      expect(options).toMatchObject({
        closeTitle: m.lightbox.close,
        zoomTitle: m.lightbox.zoom,
        arrowPrevTitle: m.lightbox.prev,
        arrowNextTitle: m.lightbox.next,
        errorMsg: m.lightbox.loadError,
      });
      const button = photoswipe.elements.find((e) => e.name === 'download') as {
        title: string;
        ariaLabel: string;
        html: string;
      };
      expect(button.ariaLabel).toBe(m.lightbox.download);
      expect(button.html).toContain(m.lightbox.downloadShort);
      const dom = photoswipe.doms[0];
      expect(dom?.element).toHaveAttribute('aria-label', m.lightbox.dialog);
      expect(dom?.scrollWrap).toHaveAttribute('aria-roledescription', m.lightbox.carousel);
      for (const holder of dom?.holders ?? []) {
        expect(holder).toHaveAttribute('aria-roledescription', m.lightbox.slide);
      }
      const texts = [
        ...Object.values(options).filter((v): v is string => typeof v === 'string'),
        button.title,
        button.ariaLabel,
        button.html,
        dom?.element.getAttribute('aria-label') ?? '',
      ];
      for (const text of texts) expect(text).not.toMatch(/[\u0E00-\u0E7F]/);
      // The page around it too: no Thai anywhere on screen or in an accessible label.
      expect(document.body.textContent).not.toMatch(/[\u0E00-\u0E7F]/);
      for (const el of document.querySelectorAll('[aria-label],[title],[alt]')) {
        const label = ['aria-label', 'title', 'alt'].map((a) => el.getAttribute(a) ?? '').join('');
        expect(label).not.toMatch(/[\u0E00-\u0E7F]/);
      }
    },
  );

  it('arrows show on touch phones: our rule beats PhotoSwipe\u2019s touch rule', () => {
    const css = readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');
    expect(css).toMatch(/\.pswp\.pswp--touch \.pswp__button--arrow \{\s*visibility: visible;/);
    // The rule we override is still PhotoSwipe's (two classes; ours has three).
    const require = createRequire(import.meta.url);
    const pswpCss = readFileSync(require.resolve('photoswipe/style.css'), 'utf8');
    expect(pswpCss).toMatch(/\n\.pswp--touch \.pswp__button--arrow \{\s*visibility: hidden;/);
  });
});
