import { DRIVE_ROOT, DRIVE_ROUTES, ME_ROUTES, SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { DriveBrowser } from '@/components/drive/drive-browser';
import { ShareDetails } from '@/components/shares/share-details';
import { SharesList } from '@/components/shares/shares-list';
import { createPublicApiClient } from '@/lib/api/client';
import { th } from '@/messages/th';
import { LogoutButton } from './logout-button';
import { StudioGate } from './studio-gate';

async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `ตัวเลือกของ ${name}` }));
}

/** Opens an item's kebab menu and follows a path of (sub)menu items. */
async function choose(name: string, ...path: string[]) {
  await openMenu(name);
  for (const label of path) {
    await userEvent.click(await screen.findByRole('menuitem', { name: label }));
  }
}

describe('studio gate (ADR 0010: accounts come from admins only)', () => {
  it('tells a signed-in viewer account to ask the admin; no self-serve upgrade', async () => {
    const fake = new FakeApi({ role: 'user' });
    renderWithProviders(
      <StudioGate>
        <p>studio content</p>
      </StudioGate>,
      { api: apiClientFor(fake.fetch) },
    );
    expect(
      await screen.findByRole('heading', { name: th.notPhotographer.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(th.notPhotographer.body)).toBeInTheDocument();
    expect(screen.queryByText('studio content')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: th.studio.logout })).toBeInTheDocument();
    expect(fake.callsTo(ME_ROUTES.get)[0]?.prefix).toBe('/bff');
    expect(fake.callsTo(ME_ROUTES.becomePhotographer)).toHaveLength(0);
  });

  it('goes straight to the studio for photographers', async () => {
    const fake = new FakeApi();
    const onPasswordChangeRequired = vi.fn();
    renderWithProviders(
      <StudioGate onPasswordChangeRequired={onPasswordChangeRequired}>
        <p>studio content</p>
      </StudioGate>,
      { api: apiClientFor(fake.fetch) },
    );
    expect(await screen.findByText('studio content')).toBeInTheDocument();
    expect(onPasswordChangeRequired).not.toHaveBeenCalled();
  });

  it('sends a session with a temporary password to the change, before any drive call', async () => {
    const fake = new FakeApi({ passwordChangeRequired: true });
    const onPasswordChangeRequired = vi.fn();
    renderWithProviders(
      <StudioGate onPasswordChangeRequired={onPasswordChangeRequired}>
        <p>studio content</p>
      </StudioGate>,
      { api: apiClientFor(fake.fetch) },
    );
    await waitFor(() => expect(onPasswordChangeRequired).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('studio content')).not.toBeInTheDocument();
    expect(fake.calls.map((c) => c.path)).toEqual(['/me']);
  });
});

describe('logout', () => {
  it('deletes the viewer session at /api (with credentials) before posting the logout form', async () => {
    const fake = new FakeApi();
    fake.viewerSession = true;
    const submitted = vi.fn((form: HTMLFormElement) => form.getAttribute('action'));
    renderWithProviders(
      <LogoutButton
        publicApi={createPublicApiClient({ fetch: fake.fetch })}
        onSubmitForm={submitted}
      />,
      { api: apiClientFor(fake.fetch) },
    );
    await userEvent.click(screen.getByRole('button', { name: th.studio.logout }));
    await waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
    expect(submitted.mock.results[0]?.value).toBe('/auth/logout');
    const deleted = fake.callsTo(ME_ROUTES.deleteViewerSession);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ prefix: '/api', credentials: 'include' });
    expect(fake.viewerSession).toBe(false);
  });
});

describe('share management', () => {
  it('creates a folder share with password and expiry, lists it, copies and revokes it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fake = new FakeApi();
    const folder = fake.addFolder('งานวิ่ง 2569');
    renderWithProviders(<DriveBrowser folderRef={DRIVE_ROOT} />, { api: apiClientFor(fake.fetch) });
    await choose(folder.name, th.itemMenu.share, th.itemMenu.createShare);
    const dialog = await screen.findByRole('dialog', { name: `แชร์ “${folder.name}”` });
    expect(within(dialog).getByText(th.shareDialog.none)).toBeInTheDocument();
    // Face search is off: no face_only option.
    expect(within(dialog).queryByRole('radio', { name: th.shareForm.modes.face_only })).toBeNull();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: th.shareForm.usePassword }));
    await userEvent.type(within(dialog).getByLabelText(th.shareForm.password), 'ab');
    await userEvent.click(within(dialog).getByRole('button', { name: th.shareForm.create }));
    expect(await within(dialog).findByText(/รหัสผ่านต้องยาว 4–128 ตัวอักษร/)).toBeInTheDocument();
    expect(fake.callsTo(SHARE_ROUTES.create)).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText(th.shareForm.password), 'cd');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: th.shareForm.useExpiry }));
    await userEvent.type(within(dialog).getByLabelText(th.shareForm.expiry), '2099-12-31');
    await userEvent.selectOptions(
      within(dialog).getByLabelText(th.shareForm.downloadSize),
      th.shareForm.downloadSizes.original,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: th.shareForm.create }));
    expect(await within(dialog).findByText(th.shareDialog.created)).toBeInTheDocument();
    expect(fake.callsTo(SHARE_ROUTES.create)[0]?.body).toEqual({
      target: { type: 'folder', folderId: folder.id },
      mode: 'gallery',
      allowDownload: true,
      downloadSize: 'original',
      requireLogin: false,
      password: 'abcd',
      expiresAt: '2099-12-31T16:59:59.999Z',
    });

    // The new link is listed with its flags; copy puts the URL on the clipboard.
    const share = [...fake.ownerShares.values()][0]?.share;
    // ADR 0011: the readable slug link (the folder's name), not the token.
    expect(share?.slug).toBe('งานวิ่ง-2569');
    expect(share?.url).toBe(`https://photos.example.com/s/${encodeURIComponent('งานวิ่ง-2569')}`);
    expect(share?.url).not.toContain(share?.token ?? '-');
    expect(await within(dialog).findByText(share?.url ?? '')).toBeInTheDocument();
    expect(within(dialog).getByText(/มีรหัสผ่าน/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: th.shares.copy }));
    expect(writeText).toHaveBeenCalledWith(share?.url);
    expect(await within(dialog).findByText(th.shares.copied)).toBeInTheDocument();

    // The "delete my face" link to send on request (studio only; ADR 0011 decision 2).
    expect(within(dialog).getByText(th.shares.deletionLinkHint)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: th.shares.copyDeletionLink }));
    expect(writeText).toHaveBeenLastCalledWith(
      `https://photos.example.com/s/${encodeURIComponent('งานวิ่ง-2569')}/delete-my-face`,
    );
    expect(await within(dialog).findByText(th.shares.deletionLinkCopied)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: th.shares.revoke }));
    const confirm = await screen.findByRole('dialog', { name: th.shares.revokeTitle });
    await userEvent.click(within(confirm).getByRole('button', { name: th.shares.revoke }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.revoke)).toHaveLength(1));
    expect(await within(dialog).findByText(th.shares.status.revoked)).toBeInTheDocument();
  });

  it('offers face_only for folders only when me.features.faceSearch is on', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const folder = fake.addFolder('Event');
    const file = fake.addFile('a.jpg');
    renderWithProviders(<DriveBrowser folderRef={DRIVE_ROOT} />, { api: apiClientFor(fake.fetch) });
    await choose(folder.name, th.itemMenu.share, th.itemMenu.createShare);
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('radio', { name: th.shareForm.modes.face_only }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: th.shareForm.create }));
    await within(dialog).findByText(th.shareDialog.created);
    expect(fake.callsTo(SHARE_ROUTES.create)[0]?.body).toMatchObject({ mode: 'face_only' });
    await userEvent.keyboard('{Escape}');

    await choose(file.name, th.itemMenu.share, th.itemMenu.createShare);
    dialog = await screen.findByRole('dialog', { name: `แชร์ “${file.name}”` });
    expect(within(dialog).queryByRole('radio', { name: th.shareForm.modes.face_only })).toBeNull();
    expect(within(dialog).getByText(th.shareForm.faceOnlyFolderOnly)).toBeInTheDocument();
  });

  it('lists all shares and shows per-share stats and edits settings', async () => {
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    const api = apiClientFor(fake.fetch);
    const created = await api.call(SHARE_ROUTES.create, {
      body: { target: { type: 'folder', folderId: folder.id }, password: 'secret' },
    });
    const list = renderWithProviders(<SharesList />, { api });
    const items = await screen.findByRole('list', { name: th.shares.listLabel });
    expect(within(items).getByText(created.url)).toBeInTheDocument();
    expect(within(items).getByRole('link', { name: th.shares.stats })).toHaveAttribute(
      'href',
      `/studio/shares/${created.id}`,
    );
    list.unmount();

    renderWithProviders(<ShareDetails shareId={created.id} />, { api });
    const totals = await screen.findAllByText(th.shareStats.visitors);
    // One card in the totals and one column in the per-day table.
    expect(totals).toHaveLength(2);
    expect(totals[0]?.nextElementSibling).toHaveTextContent('30');
    expect(screen.getByText('2026-10-24')).toBeInTheDocument();
    expect(screen.getByText(/อัปเดตล่าสุด/)).toBeInTheDocument();
    expect(fake.callsTo(SHARE_ROUTES.stats)).toHaveLength(1);

    // Edit: turn downloads off; the password stays unless retyped.
    await userEvent.click(screen.getByRole('checkbox', { name: th.shareForm.allowDownload }));
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.save }));
    expect(await screen.findByText(th.shareForm.saved)).toBeInTheDocument();
    const patch = fake.callsTo(SHARE_ROUTES.update)[0]?.body as Record<string, unknown>;
    expect(patch).toMatchObject({ allowDownload: false, expiresAt: null });
    expect('password' in patch).toBe(false);
  });
});

describe('face index (always on, ADR 0011), folder cover and owner download', () => {
  it('has no face-index setting: no menu entry, no informed checkbox', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const folder = fake.addFolder('Event');
    renderWithProviders(<DriveBrowser folderRef={DRIVE_ROOT} />, { api: apiClientFor(fake.fetch) });
    await choose(folder.name, th.itemMenu.organize);
    expect(await screen.findByRole('menuitem', { name: th.itemMenu.moveTo })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /ใบหน้า/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(fake.callsTo(DRIVE_ROUTES.updateFaceIndex)).toHaveLength(0);
  });

  it('sets a photo as the folder cover, and goes back to the first photo', async () => {
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    const photo = fake.addFile('cover.jpg', folder.id);
    fake.addFile('clip.mp4', folder.id, { mediaKind: 'video', mime: 'video/mp4' });
    renderWithProviders(<DriveBrowser folderRef={folder.id} />, { api: apiClientFor(fake.fetch) });

    await choose('cover.jpg', th.itemMenu.organize, th.itemMenu.coverSet);
    expect(await screen.findByText(th.itemMenu.coverSetDone)).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.updateFolder)[0]?.body).toEqual({ coverFileId: photo.id });
    expect(fake.folders.get(folder.id)?.coverFileId).toBe(photo.id);
    expect(await screen.findByText(th.itemMenu.coverBadge)).toBeInTheDocument();

    // Videos can't be covers: no entry.
    await choose('clip.mp4', th.itemMenu.organize);
    expect(await screen.findByRole('menuitem', { name: th.itemMenu.moveTo })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: th.itemMenu.coverSet })).toBeNull();
    await userEvent.keyboard('{Escape}{Escape}');

    await choose('cover.jpg', th.itemMenu.organize, th.itemMenu.coverReset);
    expect(await screen.findByText(th.itemMenu.coverResetDone)).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.updateFolder)[1]?.body).toEqual({ coverFileId: null });
    expect(fake.folders.get(folder.id)?.coverFileId).toBeNull();
  });

  it('resets a folder\u2019s cover from the folder\u2019s own menu, and shows COVER_FILE_INVALID', async () => {
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    const photo = fake.addFile('a.jpg', folder.id);
    fake.folders.set(folder.id, { ...folder, coverFileId: photo.id });
    renderWithProviders(<DriveBrowser folderRef={DRIVE_ROOT} />, { api: apiClientFor(fake.fetch) });
    await choose('Event', th.itemMenu.organize, th.itemMenu.coverReset);
    expect(await screen.findByText(th.itemMenu.coverResetDone)).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.updateFolder)[0]?.body).toEqual({ coverFileId: null });

    const processing = fake.addFile('new.jpg', folder.id, { status: 'processing' });
    const api = apiClientFor(fake.fetch);
    await expect(
      api.call(DRIVE_ROUTES.updateFolder, {
        params: { id: folder.id },
        body: { coverFileId: processing.id },
      }),
    ).rejects.toMatchObject({ code: 'COVER_FILE_INVALID', details: { reason: 'not_ready' } });
  });

  it('downloads the owner original through GET /drive/files/:id/download', async () => {
    const fake = new FakeApi();
    const file = fake.addFile('IMG_0001.jpg');
    const startDownload = vi.fn();
    renderWithProviders(<DriveBrowser folderRef={DRIVE_ROOT} startDownload={startDownload} />, {
      api: apiClientFor(fake.fetch),
    });
    await choose(file.name, th.itemMenu.download);
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(startDownload).toHaveBeenCalledWith(expect.stringContaining(file.id), file.name);
    const call = fake.callsTo(DRIVE_ROUTES.downloadFile)[0];
    expect(call).toMatchObject({ prefix: '/bff', path: `/drive/files/${file.id}/download` });
  });
});
