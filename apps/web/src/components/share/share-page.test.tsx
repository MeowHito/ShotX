import { ME_ROUTES, PUBLIC_SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { renderSharePage } from '../../../test/share-harness';
import { th } from '@/messages/th';

const photoswipe = vi.hoisted(() => ({ instances: [] as Record<string, unknown>[] }));
vi.mock('photoswipe', () => ({
  default: class {
    ui = { registerElement: vi.fn() };
    currIndex = 0;
    constructor(options: Record<string, unknown>) {
      photoswipe.instances.push(options);
    }
    on() {}
    init() {}
    destroy() {}
  },
}));

beforeAll(() => {
  // jsdom has no media playback.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
});

describe('share page: states', () => {
  it('shows the gallery with header, virtualized grid and public calls at /api with credentials', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ itemCount: 3 });
    renderSharePage(fake, share.token);

    expect(await screen.findByRole('heading', { name: share.title })).toBeInTheDocument();
    expect(screen.getByText('ถ่ายโดย Somchai')).toBeInTheDocument();
    expect(screen.getByText('3 รูป')).toBeInTheDocument();
    const grid = await screen.findByRole('list', { name: th.share.galleryLabel });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(3);

    const publicCalls = fake.calls.filter((c) => c.path.startsWith('/s/'));
    expect(publicCalls.length).toBeGreaterThan(0);
    for (const call of publicCalls) {
      expect(call.prefix).toBe('/api');
      expect(call.credentials).toBe('include');
    }
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

  it.each(['revoked', 'expired', 'unavailable'] as const)(
    'shows "ลิงก์นี้หมดอายุ" for SHARE_EXPIRED (%s)',
    async (reason) => {
      const fake = new FakeApi();
      const share = fake.addPublicShare({ expiredReason: reason });
      renderSharePage(fake, share.token);
      expect(await screen.findByRole('heading', { name: 'ลิงก์นี้หมดอายุ' })).toBeInTheDocument();
      expect(screen.getByText(th.share.unavailable.reasons[reason])).toBeInTheDocument();
      // The PDPA deletion request outlives the share.
      expect(screen.getByRole('link', { name: th.share.deleteMyFace })).toHaveAttribute(
        'href',
        `/s/${share.token}/delete-my-face`,
      );
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
    const next = encodeURIComponent(`/s/${share.token}`);
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
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: th.share.login.title })).toBeNull();
  });

  it('login required with only the dev login (local): links to the sign-in page', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ requireLogin: true });
    renderSharePage(fake, share.token, { viewerLogin: { oidc: [], devLogin: true } });
    expect(await screen.findByRole('link', { name: th.share.login.devLogin })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/s/${share.token}`)}`,
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

  it('flag off: no scan or consent links, but "ขอลบใบหน้าของฉัน" is still offered', async () => {
    const fake = new FakeApi({ faceSearch: false });
    const share = fake.addPublicShare({ faceSearchAvailable: false });
    renderSharePage(fake, share.token);
    await screen.findByRole('list', { name: th.share.galleryLabel });
    expect(screen.queryByRole('button', { name: th.share.scan })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: th.share.withdraw })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.share.deleteMyFace })).toHaveAttribute(
      'href',
      `/s/${share.token}/delete-my-face`,
    );
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
