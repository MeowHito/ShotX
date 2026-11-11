import {
  DRIVE_ROOT,
  DRIVE_ROUTES,
  IDEMPOTENCY_KEY_HEADER,
  type OwnerShare,
  SHARE_ROUTES,
} from '@shotx/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { th } from '@/messages/th';
import { NewMenu } from '../studio/new-menu';
import { StudioProvider } from '../studio/studio-context';
import { DriveBrowser } from './drive-browser';

const WINDOWS = { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const MAC = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
const CONFIG = {
  processingPollMs: 40,
  zipPollIntervalMs: 5,
  zipPollTimeoutMs: 5000,
  billingMode: 'offline',
  viewerLoginAvailable: true,
} as const;

function Studio({
  fake,
  folderRef,
  nav,
  startDownload,
}: {
  fake: FakeApi;
  folderRef: string;
  nav: typeof WINDOWS;
  startDownload?: (url: string, name?: string) => void;
}) {
  void fake;
  return (
    <StudioProvider nav={nav as Navigator} config={CONFIG}>
      <NewMenu />
      <DriveBrowser key={folderRef} folderRef={folderRef} startDownload={startDownload} />
    </StudioProvider>
  );
}

function renderStudio(
  fake: FakeApi,
  options: { folderRef?: string; nav?: typeof WINDOWS; startDownload?: (u: string) => void } = {},
) {
  const props = {
    fake,
    folderRef: options.folderRef ?? DRIVE_ROOT,
    nav: options.nav ?? WINDOWS,
    startDownload: options.startDownload,
  };
  const view = renderWithProviders(<Studio {...props} />, { api: apiClientFor(fake.fetch) });
  return {
    ...view,
    /** Shows another folder in the same studio (the clipboard survives, like navigation). */
    open: (folderRef: string) => view.rerender(<Studio {...props} folderRef={folderRef} />),
  };
}

const kebab = (name: string) =>
  screen.findByRole('button', { name: th.drive.itemActions.replace('{name}', name) });
const card = (name: string) => screen.getByTitle(name).closest('[role="listitem"]') as HTMLElement;
const primary = (name: string) =>
  within(card(name)).getAllByRole('button', { name: th.drive.select.replace('{name}', name) })[0] ??
  within(card(name)).getByRole('link');
const menuTexts = () =>
  screen.getAllByRole('menuitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
const item = (name: string) => screen.getByRole('menuitem', { name });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('item menus', () => {
  it('opens the same menu from the kebab and from a right-click, with Windows shortcut hints', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderStudio(fake);

    await user.click(await kebab('IMG_0001.jpg'));
    const fromKebab = menuTexts();
    expect(fromKebab).toEqual([
      `${th.itemMenu.download}Shift+D`,
      `${th.itemMenu.rename}Ctrl+Alt+E`,
      `${th.itemMenu.copy}Ctrl+C Ctrl+V`,
      th.itemMenu.share,
      th.itemMenu.organize,
      th.itemMenu.fileInfo,
      `${th.itemMenu.trash}Delete`,
    ]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    fireEvent.contextMenu(screen.getByTitle('IMG_0001.jpg'));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(menuTexts()).toEqual(fromKebab);
  });

  it('shows ⌘ and ⌥ hints on a Mac (and iPadOS)', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderStudio(fake, { nav: MAC });
    await user.click(await kebab('IMG_0001.jpg'));
    expect(item(th.itemMenu.rename)).toHaveTextContent('⌥⌘E');
    expect(item(th.itemMenu.copy)).toHaveTextContent('⌘C ⌘V');
    expect(item(th.itemMenu.trash)).toHaveTextContent('⌘⌫');
  });

  it('works from the keyboard: arrows, Enter, and → into submenus', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi({ faceSearch: true });
    fake.addFolder('Event');
    renderStudio(fake);
    (await kebab('Event')).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    const focusOn = async (name: string) => {
      for (
        let i = 0;
        i < 10 && document.activeElement?.textContent?.startsWith(name) !== true;
        i++
      ) {
        await user.keyboard('{ArrowDown}');
      }
      expect(document.activeElement).toHaveTextContent(name);
    };
    await focusOn(th.itemMenu.organize);
    await user.keyboard('{ArrowRight}');
    expect(
      await screen.findByRole('menuitem', { name: th.itemMenu.faceIndex }),
    ).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    (await kebab('Event')).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await focusOn(th.itemMenu.rename);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: th.rename.title })).toBeInTheDocument();
  });

  it('disables what isn’t possible yet, and adapts to a selection of several', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    fake.addFile('IMG_0002.jpg');
    fake.addFile('clip.mp4', null, {
      status: 'processing',
      mediaKind: 'video',
      thumbUrl: undefined,
    });
    renderStudio(fake);

    await user.click(await kebab('clip.mp4'));
    expect(item(th.itemMenu.download)).toHaveAttribute('aria-disabled', 'true');
    expect(item(th.itemMenu.copy)).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');

    for (const name of ['IMG_0001.jpg', 'IMG_0002.jpg']) {
      await user.click(
        screen.getByRole('checkbox', { name: th.drive.select.replace('{name}', name) }),
      );
    }
    await user.click(await kebab('IMG_0001.jpg'));
    // Two items: no rename, info or share; a ZIP of a selection waits for its endpoint.
    expect(item(th.itemMenu.downloadZip)).toHaveAttribute('aria-disabled', 'true');
    expect(item(th.itemMenu.downloadZip)).toHaveTextContent(th.itemMenu.soon);
    expect(screen.queryByRole('menuitem', { name: th.itemMenu.rename })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: th.itemMenu.fileInfo })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: th.itemMenu.share })).not.toBeInTheDocument();
    await user.click(item(th.itemMenu.trash));
    expect(await screen.findByText('ย้าย 2 รายการไปถังขยะแล้ว')).toBeInTheDocument();
    const trashed = fake.callsTo(DRIVE_ROUTES.trashItems)[0]?.body as { items: { kind: string }[] };
    expect(trashed.items.map((i) => i.kind)).toEqual(['file', 'file']);
  });

  it('offers "คัดลอกลิงก์" only when the item has an active share', async () => {
    const user = userEvent.setup();
    // After setup(): user-event installs its own clipboard stub.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fake = new FakeApi();
    const shared = fake.addFolder('Shared');
    fake.addFolder('Private');
    const share = {
      id: crypto.randomUUID(),
      token: 'aB3dE5fG7hJ9kL1mN3pQ5r',
      url: 'https://photos.example.com/s/aB3dE5fG7hJ9kL1mN3pQ5r',
      target: { type: 'folder', id: shared.id, name: 'Shared', unavailable: false },
      mode: 'gallery',
      allowDownload: true,
      downloadSize: 'web',
      requireLogin: false,
      passwordProtected: false,
      expiresAt: null,
      status: 'active',
      createdAt: '2026-10-25T05:00:00.000Z',
    } satisfies OwnerShare;
    fake.ownerShares.set(share.id, { share, password: null });
    renderStudio(fake);

    await user.click(await kebab('Private'));
    await user.click(item(th.itemMenu.share));
    expect(
      await screen.findByRole('menuitem', { name: th.itemMenu.createShare }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: th.itemMenu.copyLink })).not.toBeInTheDocument();
    await user.keyboard('{Escape}{Escape}');

    // From the keyboard: Enter on the kebab, down to "แชร์", → into the submenu, Enter.
    (await kebab('Shared')).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    for (let i = 0; i < 10 && document.activeElement?.textContent !== th.itemMenu.share; i++) {
      await user.keyboard('{ArrowDown}');
    }
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('menuitem', { name: th.itemMenu.copyLink });
    for (let i = 0; i < 10 && document.activeElement?.textContent !== th.itemMenu.copyLink; i++) {
      await user.keyboard('{ArrowDown}');
    }
    await user.keyboard('{Enter}');
    expect(writeText).toHaveBeenCalledWith(share.url);
    expect(await screen.findByText(th.itemMenu.linkCopied)).toBeInTheDocument();
    expect(fake.callsTo(SHARE_ROUTES.list).some((c) => c.path.includes('folderId='))).toBe(false);
  });
});

describe('keyboard shortcuts and selection', () => {
  it('acts on the focused item: rename, download, trash; never while typing in a dialog', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const file = fake.addFile('IMG_0001.jpg');
    const startDownload = vi.fn();
    renderStudio(fake, { startDownload });
    await screen.findByTitle('IMG_0001.jpg');

    primary('IMG_0001.jpg').focus();
    await user.keyboard('{Shift>}D{/Shift}');
    await waitFor(() =>
      expect(startDownload).toHaveBeenCalledWith(expect.stringContaining(file.id), file.name),
    );

    primary('IMG_0001.jpg').focus();
    await user.keyboard('{Control>}{Alt>}e{/Alt}{/Control}');
    const dialog = await screen.findByRole('dialog', { name: th.rename.title });
    const input = within(dialog).getByLabelText(th.rename.nameLabel);
    await user.type(input, '{Delete}{Backspace}');
    expect(fake.callsTo(DRIVE_ROUTES.trashItems)).toHaveLength(0);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    primary('IMG_0001.jpg').focus();
    await user.keyboard('{Delete}');
    expect(await screen.findByText('ย้าย 1 รายการไปถังขยะแล้ว')).toBeInTheDocument();
  });

  it('ignores keys during IME composition (Thai input)', async () => {
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderStudio(fake);
    await screen.findByTitle('IMG_0001.jpg');
    primary('IMG_0001.jpg').focus();
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'Delete',
      code: 'Delete',
      isComposing: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.callsTo(DRIVE_ROUTES.trashItems)).toHaveLength(0);
  });

  it('selects all with Ctrl+A, clears with Esc, and moves focus with arrows (Shift extends)', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) fake.addFile(n);
    renderStudio(fake);
    await screen.findByTitle('c.jpg');

    primary('a.jpg').focus();
    await user.keyboard('{Control>}a{/Control}');
    expect(screen.getByRole('status')).toHaveTextContent('เลือกแล้ว 3 รายการ');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(/เลือกแล้ว/)).not.toBeInTheDocument());

    primary('a.jpg').focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(document.activeElement).toBe(primary('b.jpg')));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await waitFor(() => expect(document.activeElement).toBe(primary('c.jpg')));
    expect(screen.getByRole('status')).toHaveTextContent('เลือกแล้ว 2 รายการ');
  });

  it('Ctrl+click toggles and Shift+click selects a range; in selection mode a folder tap selects it', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFolder('Event');
    for (const n of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) fake.addFile(n);
    renderStudio(fake);
    await screen.findByTitle('d.jpg');

    await user.click(primary('a.jpg'));
    await user.keyboard('{Shift>}');
    await user.click(primary('c.jpg'));
    await user.keyboard('{/Shift}');
    expect(screen.getByRole('status')).toHaveTextContent('เลือกแล้ว 3 รายการ');
    await user.keyboard('{Control>}');
    await user.click(primary('b.jpg'));
    await user.keyboard('{/Control}');
    expect(screen.getByRole('status')).toHaveTextContent('เลือกแล้ว 2 รายการ');
    // Selection mode: tapping the folder selects it instead of opening it.
    await user.click(within(card('Event')).getByRole('link'));
    expect(screen.getByRole('status')).toHaveTextContent('เลือกแล้ว 3 รายการ');
  });
});

describe('trash safety', () => {
  it('on a Mac a plain ⌫ does nothing; ⌘⌫ trashes, and the notice can undo it', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const file = fake.addFile('IMG_0001.jpg');
    renderStudio(fake, { nav: MAC });
    await screen.findByTitle('IMG_0001.jpg');

    primary('IMG_0001.jpg').focus();
    await user.keyboard('{Meta>}a{/Meta}{Backspace}');
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.callsTo(DRIVE_ROUTES.trashItems)).toHaveLength(0);

    await user.keyboard('{Meta>}{Backspace}{/Meta}');
    expect(await screen.findByText('ย้าย 1 รายการไปถังขยะแล้ว')).toBeInTheDocument();
    expect(fake.files.get(file.id)?.deletedAt).not.toBeNull();
    await user.click(screen.getByRole('button', { name: th.drive.undo }));
    expect(await screen.findByText('กู้คืน 1 รายการแล้ว')).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.restoreItems)[0]?.body).toEqual({
      items: [{ kind: 'file', id: file.id }],
    });
    expect(fake.files.get(file.id)?.deletedAt).toBeNull();
    expect(await screen.findByTitle('IMG_0001.jpg')).toBeInTheDocument();
  });

  it('offers undo after trashing from the menu, the selection bar and Delete', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) fake.addFile(n);
    renderStudio(fake);
    await screen.findByTitle('c.jpg');

    // The item menu.
    await user.click(await kebab('a.jpg'));
    await user.click(item(th.itemMenu.trash));
    await user.click(await screen.findByRole('button', { name: th.drive.undo }));
    expect(await screen.findByText('กู้คืน 1 รายการแล้ว')).toBeInTheDocument();

    // The selection bar.
    await user.click(
      screen.getByRole('checkbox', { name: th.drive.select.replace('{name}', 'b.jpg') }),
    );
    await user.click(screen.getByRole('button', { name: th.drive.moveToTrash }));
    await user.click(await screen.findByRole('button', { name: th.drive.undo }));
    expect(await screen.findByText('กู้คืน 1 รายการแล้ว')).toBeInTheDocument();

    // The Delete key (Windows/Linux).
    primary('c.jpg').focus();
    await user.keyboard('{Delete}');
    await user.click(await screen.findByRole('button', { name: th.drive.undo }));
    expect(await screen.findByText('กู้คืน 1 รายการแล้ว')).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.restoreItems)).toHaveLength(3);
    expect([...fake.files.values()].every((f) => f.deletedAt === null)).toBe(true);
  });
});

describe('copy, folder ZIP and details', () => {
  it('Ctrl+C then Ctrl+V in another folder copies there; the copy shows processing until ready', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const from = fake.addFolder('From');
    const to = fake.addFolder('To');
    const file = fake.addFile('IMG_0001.jpg', from.id);
    fake.copyReadyAfterListings = 3;
    const view = renderStudio(fake, { folderRef: from.id });
    await screen.findByTitle('IMG_0001.jpg');

    primary('IMG_0001.jpg').focus();
    await user.keyboard('{Control>}c{/Control}');
    expect(await screen.findByText(/จำ 1 ไฟล์ไว้แล้ว/)).toHaveTextContent('Ctrl+V');

    view.open(to.id);
    await screen.findByText(th.drive.empty);
    // A lost response is retried with the same clientCopyId: still one copy.
    fake.dropResponseOnce.add(DRIVE_ROUTES.copyFile);
    await user.keyboard('{Control>}v{/Control}');
    expect(await screen.findByText(/ทำสำเนา 1 ไฟล์แล้ว/)).toBeInTheDocument();
    const calls = fake.callsTo(DRIVE_ROUTES.copyFile);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe(`/drive/files/${file.id}/copy`);
    expect(calls[0]?.body).toMatchObject({ targetFolderId: to.id, onNameConflict: 'rename' });
    expect((calls[0]?.body as { clientCopyId: string }).clientCopyId).toBe(
      (calls[1]?.body as { clientCopyId: string }).clientCopyId,
    );
    expect([...fake.files.values()].filter((f) => f.folderId === to.id)).toHaveLength(1);
    // Processing first, then the listing refreshes itself until the copy is ready.
    expect(await screen.findByText(th.drive.fileStatus.processing)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(th.drive.fileStatus.processing)).not.toBeInTheDocument(),
    );
  });

  it('"ทำสำเนา" copies next to the original as "name (2)"', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderStudio(fake);
    await user.click(await kebab('IMG_0001.jpg'));
    await user.click(item(th.itemMenu.copy));
    expect(await screen.findByTitle('IMG_0001 (2).jpg')).toBeInTheDocument();
  });

  it('downloads a folder as a ZIP: job, polling, then the archive', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const folder = fake.addFolder('Event');
    fake.addFile('IMG_0001.jpg', folder.id);
    const startDownload = vi.fn();
    renderStudio(fake, { startDownload });
    await user.click(await kebab('Event'));
    await user.click(item(th.itemMenu.downloadZip));
    await waitFor(() =>
      expect(startDownload).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/zips/'),
        'Event.zip',
      ),
    );
    const start = fake.callsTo(DRIVE_ROUTES.downloadFolder)[0];
    expect(start?.body).toEqual({ size: 'original' });
    expect(start?.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.callsTo(DRIVE_ROUTES.ownerZipJob).length).toBeGreaterThan(0);
  });

  it('says so when there is nothing to zip (CONFLICT)', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFolder('Empty');
    renderStudio(fake);
    await user.click(await kebab('Empty'));
    await user.click(item(th.itemMenu.downloadZip));
    expect(await screen.findByText(th.errors.codes.CONFLICT)).toBeInTheDocument();
  });

  it('shows file and folder details with their location and summary', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const event = fake.addFolder('Event');
    const day = fake.addFolder('Day 1', event.id);
    fake.addFile('IMG_0001.jpg', day.id, { takenAt: '2026-03-01T02:00:00.000Z' });
    fake.addFile('clip.mp4', day.id, { mediaKind: 'video', mime: 'video/mp4', sizeBytes: 3000 });
    renderStudio(fake, { folderRef: event.id });

    await user.click(await kebab('Day 1'));
    await user.click(item(th.itemMenu.folderInfo));
    const panel = await screen.findByRole('dialog', { name: 'Day 1' });
    expect(await within(panel).findByText('2 ไฟล์ (รูปภาพ 1 · วิดีโอ 1)')).toBeInTheDocument();
    expect(within(panel).getByText('ไดรฟ์ของฉัน › Event')).toBeInTheDocument();
    expect(within(panel).getByText('3.9 KB')).toBeInTheDocument();
  });
});

describe('touch', () => {
  it('a long-press (500 ms) opens the item menu on tablets, and the following tap does nothing', async () => {
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderStudio(fake);
    const target = await screen.findByTitle('IMG_0001.jpg');
    fireEvent.pointerDown(target, { pointerType: 'touch', clientX: 50, clientY: 60 });
    await act(() => new Promise((r) => setTimeout(r, 550)));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    fireEvent.pointerUp(target, { pointerType: 'touch' });
    fireEvent.click(target);
    expect(screen.queryByText(/เลือกแล้ว/)).not.toBeInTheDocument();
  });

  it('moving the finger is a scroll, not a long-press', async () => {
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderStudio(fake);
    const target = await screen.findByTitle('IMG_0001.jpg');
    fireEvent.pointerDown(target, { pointerType: 'touch', clientX: 50, clientY: 60 });
    fireEvent.pointerMove(target, { pointerType: 'touch', clientX: 50, clientY: 120 });
    await act(() => new Promise((r) => setTimeout(r, 550)));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('on phones the kebab and a long-press open a bottom sheet with 48 px rows', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query === '(max-width: 639px)',
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFile('IMG_0001.jpg');
    renderStudio(fake);
    await user.click(await kebab('IMG_0001.jpg'));
    const sheet = await screen.findByRole('dialog', { name: 'IMG_0001.jpg' });
    const rename = within(sheet).getByRole('button', { name: th.itemMenu.rename });
    expect(rename.className).toContain('min-h-12');
    expect(within(sheet).getByRole('group', { name: th.itemMenu.share })).toBeInTheDocument();
    await user.click(rename);
    expect(await screen.findByRole('dialog', { name: th.rename.title })).toBeInTheDocument();
  });
});
