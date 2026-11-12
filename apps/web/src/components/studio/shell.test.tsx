import { DRIVE_ROUTES, ME_ROUTES } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { createPublicApiClient } from '@/lib/api/client';
import { th } from '@/messages/th';
import { AccountMenu } from './account-menu';
import { RecentView } from './recent-view';
import { SearchView } from './search-view';
import { activeNav, SidebarNav } from './sidebar-nav';
import { storageLevel } from './storage-meter';
import { DEFAULT_STUDIO_CONFIG, StudioProvider } from './studio-context';
import { StudioShellView } from './studio-shell';

const GATEWAY = { ...DEFAULT_STUDIO_CONFIG, billingMode: 'gateway' } as const;

const GB = 1024 ** 3;
const MAC = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' } as Navigator;

function renderShell(
  fake: FakeApi,
  options: {
    pathname?: string;
    onSearch?: (href: string) => void;
    nav?: Navigator;
    config?: typeof DEFAULT_STUDIO_CONFIG;
  } = {},
) {
  const onSearch = vi.fn<(href: string) => void>(options.onSearch);
  const view = renderWithProviders(
    <StudioShellView
      pathname={options.pathname ?? '/studio'}
      user={{ name: 'สมชาย ถ่ายภาพ', email: 'somchai@example.com' }}
      onSearch={onSearch}
      nav={options.nav}
      config={options.config}
    >
      <p>page content</p>
    </StudioShellView>,
    { api: apiClientFor(fake.fetch) },
  );
  return { ...view, onSearch, aside: view.container.querySelector('aside') as HTMLElement };
}

describe('aside', () => {
  it('lists the studio sections in Thai and marks the current one', () => {
    renderWithProviders(<SidebarNav pathname="/studio/folders/abc" />, {
      api: apiClientFor(new FakeApi().fetch),
    });
    const links = within(screen.getByRole('navigation', { name: th.studio.navLabel })).getAllByRole(
      'link',
    );
    // BILLING_MODE=offline (the default, ADR 0010): no plans and payment.
    expect(links.map((l) => l.textContent)).toEqual([
      'ไดรฟ์ของฉัน',
      'ล่าสุด',
      'ลิงก์ที่แชร์',
      // ADR 0013: the share page designer.
      'ออกแบบหน้าแชร์',
      'ถังขยะ',
    ]);
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(links.filter((l) => l.hasAttribute('aria-current'))).toHaveLength(1);
    expect(activeNav('/studio/shares/123')).toBe('shares');
    expect(activeNav('/studio/billing/return')).toBe('billing');
    expect(activeNav('/studio/recent')).toBe('recent');
    expect(activeNav('/studio/designs')).toBe('designs');
    expect(activeNav(`/studio/designs/${crypto.randomUUID()}`)).toBe('designs');
    expect(activeNav('/studio/search')).toBeNull();
  });

  it('lists plans and payment only with BILLING_MODE=gateway', () => {
    renderWithProviders(
      <StudioProvider config={GATEWAY}>
        <SidebarNav pathname="/studio/billing" />
      </StudioProvider>,
      { api: apiClientFor(new FakeApi().fetch) },
    );
    const billing = screen.getByRole('link', { name: th.studio.billing });
    expect(billing).toHaveAttribute('href', '/studio/billing');
    expect(billing).toHaveAttribute('aria-current', 'page');
  });

  it('without a storage limit shows the used bytes only: no bar, no limit, no upgrade', async () => {
    const fake = new FakeApi({ quotaBytes: null, usedBytes: 2 * GB });
    const { aside } = renderShell(fake);
    expect(await within(aside).findAllByText('ใช้ไป 2 GB')).not.toHaveLength(0);
    expect(within(aside).queryByRole('progressbar')).toBeNull();
    expect(within(aside).queryByText(/จาก/)).toBeNull();
    expect(within(aside).queryByRole('link', { name: th.studio.storage.add })).toBeNull();
    expect(within(aside).queryByText(th.studio.storage.full)).toBeNull();
  });

  it('with a quota but BILLING_MODE=offline keeps the bar and offers nothing to buy', async () => {
    const fake = new FakeApi({ quotaBytes: 10 * GB, usedBytes: Math.round(9.7 * GB) });
    const { aside } = renderShell(fake);
    expect(await within(aside).findAllByText(th.studio.storage.full)).not.toHaveLength(0);
    expect(within(aside).queryByRole('link', { name: th.studio.storage.add })).toBeNull();
  });

  it('shows "ใช้ไป X จาก Y" with a thin bar and the button to add storage', async () => {
    const fake = new FakeApi({ quotaBytes: 10 * GB, usedBytes: 2 * GB });
    const { aside } = renderShell(fake, { config: GATEWAY });
    expect(await within(aside).findAllByText('ใช้ไป 2 GB จาก 10 GB')).not.toHaveLength(0);
    const bar = within(aside).getAllByRole('progressbar', { name: th.studio.storage.title })[0];
    expect(bar).toHaveAttribute('data-level', 'ok');
    const add = within(aside).getAllByRole('link', { name: th.studio.storage.add })[0];
    expect(add).toHaveAttribute('href', '/studio/billing');
  });

  it('turns amber near the limit and red when full', async () => {
    const near = renderShell(new FakeApi({ quotaBytes: 10 * GB, usedBytes: Math.round(8.5 * GB) }));
    expect(await within(near.aside).findAllByText(th.studio.storage.nearlyFull)).not.toHaveLength(
      0,
    );
    expect(within(near.aside).getAllByRole('progressbar')[0]).toHaveAttribute('data-level', 'warn');
    near.unmount();
    const full = renderShell(new FakeApi({ quotaBytes: 10 * GB, usedBytes: Math.round(9.7 * GB) }));
    expect(await within(full.aside).findAllByText(th.studio.storage.full)).not.toHaveLength(0);
    expect(storageLevel(1, 0)).toBe('full');
    expect(storageLevel(79, 100)).toBe('ok');
  });

  it('is a drawer on phones (menu button) that closes after navigating', async () => {
    const user = userEvent.setup();
    const { aside } = renderShell(new FakeApi());
    // CSS breakpoints: hidden below md, a rail from md, full from lg.
    expect(aside.className).toMatch(/\bhidden\b.*\bmd:flex\b/);
    expect(aside.className).toContain('lg:w-64');
    await user.click(screen.getByRole('button', { name: th.studio.openMenu }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('link', { name: th.studio.trash }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('collapses to a rail on tablets in portrait, and expands on request', async () => {
    const user = userEvent.setup();
    const { aside } = renderShell(new FakeApi());
    const toggle = within(aside).getByRole('button', { name: th.studio.expandNav });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.className).toContain('lg:hidden');
    expect(aside.className).toContain('md:w-[4.75rem]');
    await user.click(toggle);
    expect(aside).toHaveAttribute('data-expanded', 'true');
    expect(aside.className).toContain('md:w-64');
    expect(within(aside).getByRole('button', { name: th.studio.collapseNav })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('top bar', () => {
  it('searches plain text, and with filters from the popover', async () => {
    const user = userEvent.setup();
    const { onSearch } = renderShell(new FakeApi());
    const field = screen.getByRole('searchbox', { name: th.search.label });
    await user.type(field, 'งานวิ่ง{Enter}');
    expect(onSearch).toHaveBeenLastCalledWith(`/studio/search?q=${encodeURIComponent('งานวิ่ง')}`);

    await user.click(screen.getByRole('button', { name: th.search.filters }));
    const popover = await screen.findByRole('dialog', { name: th.search.filters });
    await user.click(within(popover).getByRole('radio', { name: th.search.types.video }));
    const [takenFrom, takenTo] = within(popover).getAllByLabelText(/ตั้งแต่|ถึง/);
    await user.type(takenFrom as HTMLElement, '2026-03-10');
    await user.type(takenTo as HTMLElement, '2026-03-01');
    expect(within(popover).getByRole('alert')).toHaveTextContent(th.search.invalidRange);
    expect(within(popover).getByRole('button', { name: th.search.apply })).toBeDisabled();
    await user.clear(takenTo as HTMLElement);
    await user.type(takenTo as HTMLElement, '2026-03-31');
    await user.click(within(popover).getByRole('button', { name: th.search.apply }));
    const href = onSearch.mock.lastCall?.[0] as string;
    expect(Object.fromEntries(new URL(href, 'https://x').searchParams)).toEqual({
      q: 'งานวิ่ง',
      type: 'video',
      takenFrom: '2026-03-10',
      takenTo: '2026-03-31',
    });
    // "This folder only" needs a folder page.
    await user.click(screen.getByRole('button', { name: th.search.filters }));
    expect(
      within(await screen.findByRole('dialog')).getByRole('checkbox', {
        name: th.search.currentFolder,
      }),
    ).toBeDisabled();
  });

  it('runs the global shortcuts: / focuses search, ? and Ctrl+/ show help, Alt+C a new folder', async () => {
    const user = userEvent.setup();
    renderShell(new FakeApi());
    await user.keyboard('/');
    expect(screen.getByRole('searchbox', { name: th.search.label })).toHaveFocus();
    // Typed into the field: not a shortcut.
    await user.keyboard('?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    (document.activeElement as HTMLElement).blur();

    await user.keyboard('?');
    const help = await screen.findByRole('dialog', { name: th.shortcuts.title });
    expect(within(help).getByText('Ctrl+Alt+E')).toBeInTheDocument();
    expect(within(help).getByText(th.shortcuts.items.rename)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.keyboard('{Control>}/{/Control}');
    expect(await screen.findByRole('dialog', { name: th.shortcuts.title })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.keyboard('{Alt>}c{/Alt}');
    expect(await screen.findByRole('dialog', { name: th.createFolder.title })).toBeInTheDocument();
  });

  it('Shift+U opens the file picker; the help shows ⌘ and ⌥ on a Mac', async () => {
    const user = userEvent.setup();
    renderShell(new FakeApi(), { nav: MAC });
    const picker = screen.getByTestId('upload-files-input');
    const click = vi.spyOn(picker, 'click');
    await waitFor(() => expect(screen.getByRole('button', { name: th.studio.new })).toBeEnabled());
    await user.keyboard('{Shift>}U{/Shift}');
    await waitFor(() => expect(click).toHaveBeenCalled());
    await user.keyboard('{Meta>}/{/Meta}');
    const help = await screen.findByRole('dialog', { name: th.shortcuts.title });
    expect(within(help).getByText('⌥⌘E')).toBeInTheDocument();
    expect(within(help).getByText('⌘⌫')).toBeInTheDocument();
  });

  it('the account menu shows who is signed in and logs out (viewer session first)', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.viewerSession = true;
    const submitted = vi.fn((form: HTMLFormElement) => form.getAttribute('action'));
    renderWithProviders(
      <AccountMenu
        user={{ name: 'สมชาย ถ่ายภาพ', email: 'somchai@example.com' }}
        publicApi={createPublicApiClient({ fetch: fake.fetch })}
        onSubmitLogout={submitted}
      />,
      { api: apiClientFor(fake.fetch) },
    );
    await user.click(screen.getByRole('button', { name: th.studio.accountMenu }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('สมชาย ถ่ายภาพ')).toBeInTheDocument();
    expect(within(menu).getByText('somchai@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: th.studio.settings })).toHaveAttribute(
      'href',
      '/studio/settings',
    );
    await user.click(within(menu).getByRole('menuitem', { name: th.studio.logout }));
    await waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
    expect(submitted.mock.results[0]?.value).toBe('/auth/logout');
    expect(fake.callsTo(ME_ROUTES.deleteViewerSession)).toHaveLength(1);
  });
});

describe('recent and search pages', () => {
  it('ล่าสุด lists the newest files first and opens their details', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const event = fake.addFolder('Event');
    fake.addFile('old.jpg', event.id);
    fake.addFile('new.jpg', event.id);
    renderWithProviders(<RecentView />, { api: apiClientFor(fake.fetch) });
    const list = await screen.findByRole('list', { name: th.recent.title });
    expect(
      within(list)
        .getAllByTitle(/\.jpg$/)
        .map((e) => e.textContent),
    ).toEqual(['new.jpg', 'old.jpg']);
    expect(within(list).queryAllByRole('checkbox')).toHaveLength(0);
    await user.click(
      within(list).getByRole('button', { name: th.drive.select.replace('{name}', 'new.jpg') }),
    );
    const panel = await screen.findByRole('dialog', { name: 'new.jpg' });
    expect(await within(panel).findByText('ไดรฟ์ของฉัน › Event')).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.recent)[0]?.prefix).toBe('/bff');
  });

  it('search shows each result with its location, and asks for a criterion first', async () => {
    const fake = new FakeApi();
    const event = fake.addFolder('งานวิ่ง 2569');
    fake.addFile('วิ่ง-001.jpg', event.id);
    fake.addFile('other.jpg');
    const base = {
      type: null,
      takenFrom: null,
      takenTo: null,
      uploadedFrom: null,
      uploadedTo: null,
      folderId: null,
    };
    const view = renderWithProviders(<SearchView search={{ ...base, q: 'วิ่ง' }} />, {
      api: apiClientFor(fake.fetch),
    });
    const list = await screen.findByRole('list', { name: th.search.resultsLabel });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      `/studio/folders/${event.id}`,
    );
    expect(
      within(rows[1] as HTMLElement).getByText('ไดรฟ์ของฉัน › งานวิ่ง 2569'),
    ).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === '/drive/search')).toBeDefined();
    view.unmount();

    renderWithProviders(<SearchView search={{ ...base, q: '' }} />, {
      api: apiClientFor(fake.fetch),
    });
    expect(screen.getByText(th.search.prompt)).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.search)).toHaveLength(1);
  });

  it('search filters for photos only leave folders out and show the chips', async () => {
    const fake = new FakeApi();
    fake.addFolder('Photos folder');
    fake.addFile('Photos.jpg');
    fake.addFile('Photos.mp4', null, { mediaKind: 'video', mime: 'video/mp4' });
    renderWithProviders(
      <SearchView
        search={{
          q: 'Photos',
          type: 'image',
          takenFrom: null,
          takenTo: null,
          uploadedFrom: null,
          uploadedTo: null,
          folderId: null,
        }}
      />,
      { api: apiClientFor(fake.fetch) },
    );
    const list = await screen.findByRole('list', { name: th.search.resultsLabel });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('ชนิด: รูปภาพ')).toBeInTheDocument();
  });
});
