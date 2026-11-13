import { DRIVE_ROOT, DRIVE_ROUTES, UPLOAD_ROUTES } from '@shotx/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { th } from '@/messages/th';
import { NewMenu } from '../studio/new-menu';
import { StudioProvider } from '../studio/studio-context';
import { UploadPanel } from '../upload/upload-panel';
import { DriveBrowser } from './drive-browser';

function renderDrive(fake: FakeApi, folderRef: string = DRIVE_ROOT) {
  return renderWithProviders(
    <StudioProvider>
      <NewMenu />
      <DriveBrowser folderRef={folderRef} />
      <UploadPanel />
    </StudioProvider>,
    {
      api: apiClientFor(fake.fetch),
      upload: {
        options: {
          uploadPartBytes: fake.uploadPartBytes,
        },
      },
    },
  );
}

describe('DriveBrowser', () => {
  it('shows breadcrumbs from ancestors and the folder contents, folders first', async () => {
    const fake = new FakeApi();
    const event = fake.addFolder('งานวิ่ง 2569');
    const day = fake.addFolder('วันที่ 1', event.id);
    fake.addFolder('จุดเช็คอิน', day.id);
    fake.addFile('IMG_0001.jpg', day.id);
    fake.addFile('clip.mp4', day.id, {
      mime: 'video/mp4',
      mediaKind: 'video',
      status: 'processing',
      thumbUrl: undefined,
    });
    renderDrive(fake, day.id);

    const nav = await screen.findByRole('navigation', { name: th.drive.breadcrumbLabel });
    await waitFor(() =>
      expect(within(nav).getByText('วันที่ 1')).toHaveAttribute('aria-current', 'page'),
    );
    expect(within(nav).getByRole('link', { name: th.drive.root })).toHaveAttribute(
      'href',
      '/studio',
    );
    expect(within(nav).getByRole('link', { name: 'งานวิ่ง 2569' })).toHaveAttribute(
      'href',
      `/studio/folders/${event.id}`,
    );

    // ADR 0016: folders are events, in their own section above the files.
    const events = within(screen.getByRole('list', { name: th.event.events })).getAllByRole(
      'listitem',
    );
    expect(events.map((i) => within(i).getByTitle('จุดเช็คอิน').textContent)).toEqual([
      'จุดเช็คอิน',
    ]);
    const items = within(screen.getByRole('list', { name: 'วันที่ 1' })).getAllByRole('listitem');
    expect(items.map((i) => within(i).getByTitle(/./).textContent)).toEqual([
      'clip.mp4',
      'IMG_0001.jpg',
    ]);
    expect(screen.getByText(th.drive.fileStatus.processing)).toBeInTheDocument();
    const thumb = items[1]?.querySelector('img');
    expect(thumb?.getAttribute('src')).toMatch(/^https:\/\/photos\.example\.com\/media\//);
  });

  it('loads the next cursor page as the grid scrolls (infinite scroll)', async () => {
    const fake = new FakeApi({ pageSize: 4 });
    for (let i = 1; i <= 10; i++) fake.addFile(`IMG_${String(i).padStart(4, '0')}.jpg`);
    renderDrive(fake);
    await waitFor(() => expect(screen.getByText('IMG_0010.jpg')).toBeInTheDocument());
    const pages = fake.callsTo(DRIVE_ROUTES.listChildren);
    expect(pages.length).toBe(3);
    expect(pages[1]?.path).toBe('/drive/folders/root/children');
  });

  it('shows an empty state', async () => {
    renderDrive(new FakeApi());
    expect(await screen.findByText(th.drive.empty)).toBeInTheDocument();
  });

  it('creates a folder and shows NAME_TAKEN in Thai', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFolder('Day 1');
    renderDrive(fake);
    await screen.findByText('Day 1');

    await user.click(screen.getByRole('button', { name: th.studio.new }));
    await user.click(await screen.findByRole('menuitem', { name: th.drive.newFolder }));
    const dialog = await screen.findByRole('dialog', { name: th.createFolder.title });
    await user.type(within(dialog).getByLabelText(th.createFolder.nameLabel), 'day 1');
    await user.click(within(dialog).getByRole('button', { name: th.createFolder.submit }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'มีอีเวนต์ชื่อ “day 1” อยู่แล้วที่นี่',
    );

    const input = within(dialog).getByLabelText(th.createFolder.nameLabel);
    await user.clear(input);
    await user.type(input, 'Day 2');
    await user.click(within(dialog).getByRole('button', { name: th.createFolder.submit }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Day 2')).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.createFolder).at(-1)?.body).toEqual({
      parentId: null,
      name: 'Day 2',
    });
  });

  it('validates names on the client before calling the API', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderDrive(fake);
    await user.click(
      await screen.findByRole('button', {
        name: th.drive.itemActions.replace('{name}', 'IMG_0001.jpg'),
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: th.drive.rename }));
    const dialog = await screen.findByRole('dialog', { name: th.rename.title });
    const input = within(dialog).getByLabelText(th.rename.nameLabel);
    expect(input).toHaveValue('IMG_0001.jpg');

    await user.clear(input);
    await user.type(input, 'a/b.jpg');
    await user.click(within(dialog).getByRole('button', { name: th.rename.submit }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(th.validation.invalidName);

    await user.clear(input);
    await user.type(input, 'IMG_0001.png');
    await user.click(within(dialog).getByRole('button', { name: th.rename.submit }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(th.validation.extensionChanged);
    expect(fake.callsTo(DRIVE_ROUTES.updateFile)).toHaveLength(0);

    await user.clear(input);
    await user.type(input, 'ปก.jpeg');
    await user.click(within(dialog).getByRole('button', { name: th.rename.submit }));
    expect(await screen.findByText('ปก.jpeg')).toBeInTheDocument();
  });

  it('multi-selects items and moves them to the trash in one request', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const a = fake.addFile('a.jpg');
    const b = fake.addFile('b.jpg');
    fake.addFile('c.jpg');
    renderDrive(fake);
    await user.click(await screen.findByRole('checkbox', { name: 'เลือก a.jpg' }));
    await user.click(screen.getByRole('checkbox', { name: 'เลือก b.jpg' }));
    expect(screen.getByText('เลือกแล้ว 2 รายการ')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: th.drive.moveToTrash }));
    expect(await screen.findByText('ย้าย 2 รายการไปถังขยะแล้ว')).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.trashItems)).toHaveLength(1);
    expect(fake.callsTo(DRIVE_ROUTES.trashItems)[0]?.body).toEqual({
      items: [
        { kind: 'file', id: a.id },
        { kind: 'file', id: b.id },
      ],
    });
    await waitFor(() => expect(screen.queryByText('a.jpg')).not.toBeInTheDocument());
    expect(screen.getByText('c.jpg')).toBeInTheDocument();
  });

  it('moves items with the folder picker and blocks moving a folder into itself', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const archive = fake.addFolder('Archive');
    const event = fake.addFolder('Event');
    const file = fake.addFile('a.jpg');
    renderDrive(fake);

    await user.click(await screen.findByRole('checkbox', { name: 'เลือก Event' }));
    await user.click(screen.getByRole('checkbox', { name: 'เลือก a.jpg' }));
    await user.click(screen.getByRole('button', { name: th.drive.move }));
    const dialog = await screen.findByRole('dialog', { name: 'ย้าย 2 รายการไปที่' });

    // The folder being moved can't be opened; moving to where they are now is disabled.
    expect(await within(dialog).findByRole('button', { name: 'เปิดอีเวนต์ Event' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: th.move.here })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: 'เปิดอีเวนต์ Archive' }));
    expect(await within(dialog).findByText(th.move.noSubfolders)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: th.move.here }));

    expect(await screen.findByText('ย้าย 2 รายการแล้ว')).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.updateFolder)[0]?.body).toEqual({ parentId: archive.id });
    expect(fake.callsTo(DRIVE_ROUTES.updateFile)[0]?.body).toEqual({ folderId: archive.id });
    expect(fake.folders.get(event.id)?.parentId).toBe(archive.id);
    expect(fake.files.get(file.id)?.folderId).toBe(archive.id);
  });

  it('shows why uploads are blocked and disables upload', async () => {
    const fake = new FakeApi({ uploadsBlockedBy: 'SUBSCRIPTION_INACTIVE' });
    renderDrive(fake);
    expect(await screen.findByText(th.usage.blocked.SUBSCRIPTION_INACTIVE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.studio.new }));
    expect(await screen.findByRole('menuitem', { name: th.drive.uploadFiles })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('uploads picked files, rejecting HEIC with the hint, and refreshes the folder', async () => {
    // Desktop pickers can still return HEIC despite `accept`; don't let user-event filter it.
    const user = userEvent.setup({ applyAccept: false });
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    renderDrive(fake, folder.id);
    await screen.findByText(th.drive.empty);

    const input = screen.getByTestId('upload-files-input');
    await user.upload(input, [
      new File([new Uint8Array(1000)], 'IMG_0001.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array(10)], 'IMG_0002.HEIC', { type: 'image/heic' }),
    ]);

    const panel = await screen.findByRole('region', { name: th.upload.title });
    expect(await within(panel).findByText(th.errors.hints.heic)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(panel).getByText(th.upload.status.complete)).toBeInTheDocument(),
    );
    expect(fake.callsTo(UPLOAD_ROUTES.init)).toHaveLength(1);
    expect(fake.callsTo(UPLOAD_ROUTES.init)[0]?.body).toMatchObject({ folderId: folder.id });
    expect(await screen.findByText('IMG_0001.jpg', { selector: 'p' })).toBeInTheDocument();
  });

  it('shows the quota error from the API on the upload', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi({ quotaBytes: 2000, usedBytes: 1500 });
    renderDrive(fake);
    await screen.findByText(th.drive.empty);
    await act(() =>
      user.upload(screen.getByTestId('upload-files-input'), [
        new File([new Uint8Array(1000)], 'a.jpg', { type: 'image/jpeg' }),
      ]),
    );
    const panel = await screen.findByRole('region', { name: th.upload.title });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'พื้นที่ไม่พอ ไฟล์นี้ต้องใช้ 1,000 B แต่เหลือ 500 B',
    );
  });
});
