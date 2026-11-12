import { ME_ROUTES, PUBLIC_SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeApi, shareItem } from '../../../test/fake-api';
import { renderSharePage } from '../../../test/share-harness';
import { th } from '@/messages/th';

const photoswipe = vi.hoisted(() => ({
  instances: [] as Record<string, unknown>[],
  elements: [] as Record<string, unknown>[],
}));
vi.mock('photoswipe', () => ({
  default: class {
    ui = { registerElement: (el: Record<string, unknown>) => photoswipe.elements.push(el) };
    currIndex = 0;
    private handlers = new Map<string, () => void>();
    constructor(options: Record<string, unknown>) {
      photoswipe.instances.push(options);
      this.currIndex = options.index as number;
    }
    on(name: string, fn: () => void) {
      this.handlers.set(name, fn);
    }
    init() {
      this.handlers.get('uiRegister')?.();
    }
    destroy() {}
  },
}));

beforeAll(() => {
  // jsdom has no media playback.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

describe('share page: states', () => {
  it('layout (ADR 0011): top bar, centered title over a 16:3 cover, no photographer or count', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ itemCount: 3, faceSearchAvailable: true });
    renderSharePage(fake, share.token);

    const title = await screen.findByRole('heading', { name: share.title, level: 1 });
    expect(title.parentElement).toHaveClass('text-center');
    const nav = screen.getByRole('navigation', { name: th.publicNav.label });
    expect(within(nav).getByRole('link', { name: /หน้าแรก/ })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('group', { name: th.publicNav.language })).toBeInTheDocument();
    const cover = screen.getByTestId('share-cover');
    expect(cover).toHaveClass('aspect-[16/3]');
    expect(cover.querySelector('img')).toHaveAttribute('src', share.items[0]?.previewUrl);
    expect(cover.querySelector('img')).toHaveClass('object-cover');
    expect(screen.queryByText(/ถ่ายโดย/)).not.toBeInTheDocument();
    expect(screen.queryByText(/3 รูป/)).not.toBeInTheDocument();

    // The sticky face-search button, safe-area aware at the bottom.
    const scan = screen.getByRole('button', { name: th.share.scan });
    expect(scan.parentElement).toHaveClass('fixed', 'bottom-0');
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

  it('uses the folder\u2019s chosen cover', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 3 });
    share.coverItemId = share.items[2]?.id ?? null;
    renderSharePage(fake, share.token);
    const cover = await screen.findByTestId('share-cover');
    expect(cover.querySelector('img')).toHaveAttribute('src', share.items[2]?.previewUrl);
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
      expect(window.location.pathname).toBe(`/s/${encodeURIComponent(share.slug ?? '')}`),
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
    const button = photoswipe.elements.find((e) => e.name === 'bottomDownload') as {
      appendTo: string;
      className: string;
      html: string;
      onClick: () => void;
    };
    expect(button.appendTo).toBe('root');
    expect(button.className).toBe('pswp__download-bottom');
    expect(button.html).toContain(th.lightbox.downloadShort);
    button.onClick();
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.downloads)[0]?.body).toEqual({
      fileIds: [share.items[1]?.id],
    });
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
    const next = encodeURIComponent(`/s/${share.slug ?? ''}`);
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
      `/login?next=${encodeURIComponent(`/s/${share.slug ?? ''}`)}`,
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
    expect(screen.queryByRole('button', { name: th.share.withdraw })).not.toBeInTheDocument();
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
