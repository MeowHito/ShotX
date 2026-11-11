import { type OwnerShare, SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { DEFAULT_STUDIO_CONFIG, StudioProvider } from '@/components/studio/studio-context';
import { th } from '@/messages/th';
import { ShareForm } from './share-form';

const NO_VIEWER_LOGIN = { ...DEFAULT_STUDIO_CONFIG, viewerLoginAvailable: false };

function seedShare(fake: FakeApi, requireLogin: boolean): OwnerShare {
  const folder = fake.addFolder('Event');
  const share: OwnerShare = {
    id: crypto.randomUUID(),
    token: 'aB3dE5fG7hJ9kL1mN3pQ5r',
    url: 'https://photos.example.com/s/aB3dE5fG7hJ9kL1mN3pQ5r',
    target: { type: 'folder', id: folder.id, name: folder.name, unavailable: false },
    mode: 'gallery',
    allowDownload: true,
    downloadSize: 'web',
    requireLogin,
    passwordProtected: false,
    expiresAt: null,
    status: 'active',
    createdAt: '2026-10-25T05:00:00.000Z',
  };
  fake.ownerShares.set(share.id, { share, password: null });
  return share;
}

function renderEdit(fake: FakeApi, share: OwnerShare, config = NO_VIEWER_LOGIN) {
  const api = apiClientFor(fake.fetch);
  return renderWithProviders(
    <StudioProvider config={config}>
      <ShareForm
        kind="edit"
        share={share}
        faceSearchEnabled={false}
        onSubmit={(body) => api.call(SHARE_ROUTES.update, { params: { id: share.id }, body })}
      />
    </StudioProvider>,
    { api },
  );
}

describe('share form: require login without a viewer sign-in (LINE/Google off)', () => {
  it('create: no toggle, a short note, and requireLogin false', async () => {
    const fake = new FakeApi({ viewerLoginAvailable: false });
    const folder = fake.addFolder('Event');
    const api = apiClientFor(fake.fetch);
    renderWithProviders(
      <StudioProvider config={NO_VIEWER_LOGIN}>
        <ShareForm
          kind="create"
          targetType="folder"
          faceSearchEnabled={false}
          onSubmit={(settings) =>
            api.call(SHARE_ROUTES.create, {
              body: { target: { type: 'folder', folderId: folder.id }, ...settings },
            })
          }
        />
      </StudioProvider>,
      { api },
    );
    expect(screen.queryByRole('checkbox', { name: th.shareForm.requireLogin })).toBeNull();
    expect(screen.getByText(th.shareForm.requireLoginUnavailable)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.create }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.create)).toHaveLength(1));
    expect(fake.callsTo(SHARE_ROUTES.create)[0]?.body).toMatchObject({ requireLogin: false });
  });

  it('edit of a require_login share: can turn it off, not back on', async () => {
    const fake = new FakeApi({ viewerLoginAvailable: false });
    const share = seedShare(fake, true);
    renderEdit(fake, share);
    const toggle = screen.getByRole('checkbox', { name: th.shareForm.requireLogin });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(screen.getByText(th.shareForm.requireLoginTurnOffOnly)).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.save }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.update)).toHaveLength(1));
    expect(fake.callsTo(SHARE_ROUTES.update)[0]?.body).toMatchObject({ requireLogin: false });
    expect(fake.ownerShares.get(share.id)?.share.requireLogin).toBe(false);
  });

  it('edit of a require_login share that keeps it: requireLogin is left out, so the save works', async () => {
    const fake = new FakeApi({ viewerLoginAvailable: false });
    const share = seedShare(fake, true);
    renderEdit(fake, share);
    await userEvent.click(screen.getByRole('checkbox', { name: th.shareForm.allowDownload }));
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.save }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.update)).toHaveLength(1));
    const body = fake.callsTo(SHARE_ROUTES.update)[0]?.body as Record<string, unknown>;
    expect('requireLogin' in body).toBe(false);
    expect(body).toMatchObject({ allowDownload: false });
    expect(fake.ownerShares.get(share.id)?.share.requireLogin).toBe(true);
  });

  it('edit of a share without it: no toggle', () => {
    const fake = new FakeApi({ viewerLoginAvailable: false });
    renderEdit(fake, seedShare(fake, false));
    expect(screen.queryByRole('checkbox', { name: th.shareForm.requireLogin })).toBeNull();
    expect(screen.getByText(th.shareForm.requireLoginUnavailable)).toBeInTheDocument();
  });

  it('shows the API refusal in Thai when providers went away after the page loaded', async () => {
    const fake = new FakeApi({ viewerLoginAvailable: false });
    const share = seedShare(fake, false);
    renderEdit(fake, share, DEFAULT_STUDIO_CONFIG);
    await userEvent.click(screen.getByRole('checkbox', { name: th.shareForm.requireLogin }));
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.save }));
    expect(
      await screen.findByText(th.errors.codes.LOGIN_PROVIDER_UNAVAILABLE),
    ).toBeInTheDocument();
    expect(fake.ownerShares.get(share.id)?.share.requireLogin).toBe(false);
  });

  it('with a viewer sign-in the toggle works as before', async () => {
    const fake = new FakeApi();
    const share = seedShare(fake, false);
    renderEdit(fake, share, DEFAULT_STUDIO_CONFIG);
    await userEvent.click(screen.getByRole('checkbox', { name: th.shareForm.requireLogin }));
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.save }));
    await waitFor(() => expect(fake.ownerShares.get(share.id)?.share.requireLogin).toBe(true));
  });
});
