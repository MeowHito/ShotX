import { DRIVE_ROOT, DRIVE_ROUTES, SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { th } from '@/messages/th';
import { StudioProvider } from '../studio/studio-context';
import { DriveBrowser } from './drive-browser';
import { qrFileName } from './qr-dialog';

function renderDrive(fake: FakeApi) {
  return renderWithProviders(
    <StudioProvider>
      <DriveBrowser folderRef={DRIVE_ROOT} />
    </StudioProvider>,
    { api: apiClientFor(fake.fetch) },
  );
}

async function publish(fake: FakeApi, folderId: string) {
  return apiClientFor(fake.fetch).call(SHARE_ROUTES.create, {
    body: {
      target: { type: 'folder', folderId },
      mode: 'gallery',
      allowDownload: true,
      downloadSize: 'web',
      requireLogin: false,
      password: null,
      expiresAt: null,
      designId: null,
    },
  });
}

function cardOf(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: th.event.events });
  const item = within(list)
    .getAllByRole('listitem')
    .find((li) => within(li).queryByTitle(name) !== null);
  if (item === undefined) throw new Error(`no event card ${name}`);
  return item;
}

describe('events (ADR 0016)', () => {
  it('shows each folder as an event: cover, created date, link status, QR and edit', async () => {
    const fake = new FakeApi();
    const live = fake.addFolder('Bangkok Run');
    fake.addFile('a.jpg', live.id);
    fake.addFolder('Draft');
    await publish(fake, live.id);
    renderDrive(fake);

    await screen.findByRole('list', { name: th.event.events });
    const published = within(cardOf('Bangkok Run'));
    expect(published.getByText(th.event.status.active)).toBeInTheDocument();
    expect(published.getByText(/^สร้างเมื่อ /)).toBeInTheDocument();
    expect(cardOf('Bangkok Run').querySelector('img')?.getAttribute('src')).toMatch(/^https:/);
    expect(published.getByRole('button', { name: 'QR Code ของ Bangkok Run' })).toBeEnabled();
    expect(published.getByRole('button', { name: 'แก้ไข Bangkok Run' })).toBeInTheDocument();

    const draft = within(cardOf('Draft'));
    expect(draft.getByText(th.event.status.none)).toBeInTheDocument();
    // No link yet: nothing to encode.
    expect(draft.getByRole('button', { name: 'QR Code ของ Draft' })).toBeDisabled();
  });

  it('opens the QR code of the link with save and copy', async () => {
    const fake = new FakeApi();
    const folder = fake.addFolder('Bangkok Run');
    const share = await publish(fake, folder.id);
    renderDrive(fake);
    await screen.findByRole('list', { name: th.event.events });
    await userEvent.click(
      within(cardOf('Bangkok Run')).getByRole('button', { name: 'QR Code ของ Bangkok Run' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'QR Code ของ Bangkok Run' });
    expect(within(dialog).getByText(share.url)).toBeInTheDocument();
    expect(within(dialog).getByTestId('event-qr')).toHaveAttribute(
      'aria-label',
      `QR Code ของลิงก์ ${share.url}`,
    );
    expect(within(dialog).getByRole('button', { name: th.event.qrDialog.copy })).toBeEnabled();
    expect(qrFileName('งานวิ่ง: 2569/รอบเช้า')).toBe('งานวิ่ง 2569 รอบเช้า QR.png');
  });

  it('unpublishes and publishes again from the menu, keeping the same link', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const folder = fake.addFolder('Bangkok Run');
    const share = await publish(fake, folder.id);
    renderDrive(fake);
    await screen.findByRole('list', { name: th.event.events });

    await user.click(
      within(cardOf('Bangkok Run')).getByRole('button', {
        name: th.drive.itemActions.replace('{name}', 'Bangkok Run'),
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: th.event.unpublish }));
    expect(await screen.findByText(/ปิดไม่เผยแพร่ “Bangkok Run” แล้ว/)).toBeInTheDocument();
    expect(fake.callsTo(SHARE_ROUTES.update)[0]?.body).toEqual({ paused: true });
    await waitFor(() =>
      expect(within(cardOf('Bangkok Run')).getByText(th.event.status.paused)).toBeInTheDocument(),
    );

    await user.click(
      within(cardOf('Bangkok Run')).getByRole('button', {
        name: th.drive.itemActions.replace('{name}', 'Bangkok Run'),
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: th.event.publish }));
    expect(fake.callsTo(SHARE_ROUTES.update)[1]?.body).toEqual({ paused: false });
    await waitFor(() =>
      expect(within(cardOf('Bangkok Run')).getByText(th.event.status.active)).toBeInTheDocument(),
    );
    expect(fake.ownerShares.get(share.id)?.share.url).toBe(share.url);
  });

  it('edits the name and creates the link from the edit dialog; no cover picker', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const folder = fake.addFolder('Draft');
    fake.addFile('a.jpg', folder.id);
    fake.addFile('b.jpg', folder.id);
    renderDrive(fake);
    await screen.findByRole('list', { name: th.event.events });

    await user.click(within(cardOf('Draft')).getByRole('button', { name: 'แก้ไข Draft' }));
    const dialog = await screen.findByRole('dialog', { name: th.event.dialog.title });
    const name = within(dialog).getByLabelText(th.event.dialog.name);
    await user.clear(name);
    await user.type(name, 'Bangkok Run');
    // The cover picker is gone (owner, 2026-11-13): the event's look is its design.
    expect(within(dialog).queryByRole('button', { name: 'ใช้ b.jpg เป็นรูปปก' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: th.event.dialog.save }));
    expect(await within(dialog).findByText(th.event.dialog.saved)).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.updateFolder).map((c) => c.body)).toEqual([
      { name: 'Bangkok Run' },
    ]);
    // No designs yet: a shortcut to the designer.
    expect(
      await within(dialog).findByRole('link', { name: th.shareForm.designCreate }),
    ).toHaveAttribute('href', '/studio/designs');

    // No link yet: the share form creates one.
    await user.click(within(dialog).getByRole('button', { name: th.shareForm.create }));
    await waitFor(() => expect(fake.callsTo(SHARE_ROUTES.create)).toHaveLength(1));
    expect(
      await within(dialog).findByRole('button', { name: th.event.unpublish }),
    ).toBeInTheDocument();
  });

  it('changes the design of the published link in place: same link, no new share', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const design = fake.designs.add('Pocari');
    const folder = fake.addFolder('Trail');
    fake.addFile('a.jpg', folder.id);
    renderDrive(fake);
    await screen.findByRole('list', { name: th.event.events });
    await user.click(within(cardOf('Trail')).getByRole('button', { name: 'แก้ไข Trail' }));
    const dialog = await screen.findByRole('dialog', { name: th.event.dialog.title });
    await user.click(await within(dialog).findByRole('button', { name: th.shareForm.create }));
    await within(dialog).findByRole('button', { name: th.event.unpublish });
    const created = fake.callsTo(SHARE_ROUTES.create).at(-1)?.body as { designId?: unknown };
    expect(created.designId ?? null).toBeNull();

    const section = within(dialog).getByRole('heading', { name: th.event.dialog.design })
      .parentElement as HTMLElement;
    await user.click(within(section).getByRole('radio', { name: /Pocari/ }));
    expect(await within(dialog).findByText(th.shareDialog.designSaved)).toBeInTheDocument();
    expect(fake.callsTo(SHARE_ROUTES.update).map((c) => c.body)).toEqual([{ designId: design.id }]);
    expect(fake.callsTo(SHARE_ROUTES.create)).toHaveLength(1);
    // The link settings below don't repeat the design picker.
    expect(within(dialog).getAllByRole('radio', { name: /Pocari/ })).toHaveLength(1);
  });
});
