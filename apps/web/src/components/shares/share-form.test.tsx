import { designTemplateDoc, type OwnerShare, SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
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
    slug: 'event',
    path: '/s/event',
    url: 'https://photos.example.com/s/event',
    target: { type: 'folder', id: folder.id, name: folder.name, unavailable: false },
    mode: 'gallery',
    allowDownload: true,
    downloadSize: 'web',
    requireLogin,
    passwordProtected: false,
    expiresAt: null,
    designId: null,
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
    expect(await screen.findByText(th.errors.codes.LOGIN_PROVIDER_UNAVAILABLE)).toBeInTheDocument();
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

describe('share form: the share page design picker (ADR 0013)', () => {
  function renderCreate(fake: FakeApi, folderId: string) {
    const api = apiClientFor(fake.fetch);
    return renderWithProviders(
      <StudioProvider config={DEFAULT_STUDIO_CONFIG}>
        <ShareForm
          kind="create"
          targetType="folder"
          faceSearchEnabled={false}
          onSubmit={(settings) =>
            api.call(SHARE_ROUTES.create, {
              body: { target: { type: 'folder', folderId }, ...settings },
            })
          }
        />
      </StudioProvider>,
      { api },
    );
  }

  it('starts on "no design" without a default; picking a design sends its id', async () => {
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    const gala = fake.designs.add('Gala night', designTemplateDoc('night-gala'));
    fake.designs.add('Poster', designTemplateDoc('bold-poster'));
    renderCreate(fake, folder.id);
    const group = screen.getByRole('group', { name: th.shareForm.design });
    const none = within(group).getByRole('radio', { name: new RegExp(th.shareForm.designNone) });
    expect(none).toBeChecked();
    // Each design with a live preview.
    const option = await within(group).findByRole('radio', { name: /Gala night/ });
    expect(none).toBeChecked();
    expect(option.closest('label')?.querySelector('[data-testid="design-canvas"]')).not.toBeNull();
    await userEvent.click(option);
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.create }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.create)).toHaveLength(1));
    expect(fake.callsTo(SHARE_ROUTES.create)[0]?.body).toMatchObject({ designId: gala.id });
    expect([...fake.ownerShares.values()][0]?.share.designId).toBe(gala.id);
  });

  it('a new share starts on the default design, and "no design" can still be chosen', async () => {
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    const main = fake.designs.add('Main brand', designTemplateDoc('clean-white-card'), {
      isDefault: true,
    });
    renderCreate(fake, folder.id);
    const group = screen.getByRole('group', { name: th.shareForm.design });
    const brand = await within(group).findByRole('radio', { name: /^Main brand/ });
    await waitFor(() => expect(brand).toBeChecked());
    expect(brand.closest('label')).toHaveTextContent(th.shareForm.designIsDefault);
    await userEvent.click(
      within(group).getByRole('radio', { name: new RegExp(th.shareForm.designNone) }),
    );
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.create }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.create)).toHaveLength(1));
    expect(fake.callsTo(SHARE_ROUTES.create)[0]?.body).toMatchObject({ designId: null });
    expect(main.id).toBeTruthy();
  });

  it('an existing share keeps "no design" even when a default exists; edits send designId only when changed', async () => {
    const fake = new FakeApi();
    const main = fake.designs.add('Main brand', designTemplateDoc('clean-white-card'), {
      isDefault: true,
    });
    const share = seedShare(fake, false);
    renderEdit(fake, share, DEFAULT_STUDIO_CONFIG);
    const group = screen.getByRole('group', { name: th.shareForm.design });
    const brand = await within(group).findByRole('radio', { name: /^Main brand/ });
    expect(
      within(group).getByRole('radio', { name: new RegExp(th.shareForm.designNone) }),
    ).toBeChecked();
    expect(brand).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: th.shareForm.allowDownload }));
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.save }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.update)).toHaveLength(1));
    expect('designId' in (fake.callsTo(SHARE_ROUTES.update)[0]?.body as object)).toBe(false);

    await userEvent.click(brand);
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.save }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.update)).toHaveLength(2));
    expect(fake.callsTo(SHARE_ROUTES.update)[1]?.body).toMatchObject({ designId: main.id });
  });

  it('a design deleted meanwhile is refused with the Thai message', async () => {
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    const gone = fake.designs.add('Old');
    renderCreate(fake, folder.id);
    await userEvent.click(await screen.findByRole('radio', { name: /Old/ }));
    fake.designs.designs.delete(gone.id);
    await userEvent.click(screen.getByRole('button', { name: th.shareForm.create }));
    expect(await screen.findByText(th.errors.codes.DESIGN_NOT_FOUND)).toBeInTheDocument();
  });
});
