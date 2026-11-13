import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarNav } from '@/components/studio/sidebar-nav';
import type { ClientFolderSyncConfig } from '@/lib/server/config';
import type { SyncDirectoryHandle } from '@/lib/sync/fs-access';
import type { SyncPrepare } from '@/lib/sync/engine';
import { memorySyncStore, type SyncStore, type WatermarkSettings } from '@/lib/sync/store';
import { th } from '@/messages/th';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { FolderSyncProvider } from './folder-sync-context';
import { FolderSyncPage } from './folder-sync-page';

const CONFIG: ClientFolderSyncConfig = {
  intervalMs: 60_000,
  settleMs: 0,
  watermarkQuality: 0.92,
  maxQueued: 5,
  maxDepth: 3,
  retryDelaysMs: [],
};

const t = th.folderSync;

function emptyFolder(name: string): SyncDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *values() {
      // An empty folder.
      await Promise.resolve();
      yield* [];
    },
    queryPermission: () => Promise.resolve('granted'),
  };
}

function renderPage(
  supported: boolean,
  options: { store?: SyncStore; makePrepare?: (s: WatermarkSettings) => Promise<SyncPrepare> } = {},
) {
  const api = new FakeApi({ role: 'photographer' });
  return renderWithProviders(
    <FolderSyncProvider
      config={CONFIG}
      testing={{
        store: options.store ?? memorySyncStore(),
        supported,
        makePrepare: options.makePrepare,
      }}
    >
      <SidebarNav pathname="/studio/sync" />
      <FolderSyncPage />
    </FolderSyncProvider>,
    { api: apiClientFor(api.fetch) },
  );
}

beforeAll(() => {
  // jsdom has no object URLs (the watermark preview).
  URL.createObjectURL = () => 'blob:watermark';
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

describe('FolderSyncPage', () => {
  it('tells Safari, Firefox and phone users to use Chrome or Edge on a computer', async () => {
    renderPage(false);
    expect(await screen.findByTestId('sync-unsupported')).toHaveTextContent(t.unsupportedTitle);
  });

  it('sets up a sync: computer folder, Snap folder, start', async () => {
    const user = userEvent.setup();
    const picker = vi.fn(() => Promise.resolve(emptyFolder('Lightroom Export')));
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = picker;
    renderPage(true);

    const start = await screen.findByRole('button', { name: t.setup.start });
    expect(start).toBeDisabled();
    expect(screen.getByTestId('sync-destination')).toHaveTextContent(th.drive.root);

    await user.click(screen.getByRole('button', { name: t.setup.chooseSource }));
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ mode: 'read' }));
    expect(await screen.findByTestId('sync-source')).toHaveTextContent('Lightroom Export');

    await user.click(start);
    await waitFor(() =>
      expect(screen.getByTestId('sync-status')).toHaveAttribute('data-status', 'running'),
    );
    expect(screen.getByTestId('sync-status')).toHaveTextContent(t.status.running);
    expect(screen.getByTestId('sync-running-dot')).toBeInTheDocument();
    expect(screen.getByText(t.recentEmpty)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t.pause }));
    expect(screen.getByTestId('sync-status')).toHaveAttribute('data-status', 'paused');
    expect(screen.queryByTestId('sync-running-dot')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t.stop }));
    expect(await screen.findByRole('button', { name: t.setup.start })).toBeInTheDocument();
  });

  it('ADR 0021: sets a watermark (image, position, size, opacity), saves it and keeps it', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const store = memorySyncStore();
    const prepared: WatermarkSettings[] = [];
    const makePrepare = (settings: WatermarkSettings) => {
      prepared.push(settings);
      return Promise.resolve<SyncPrepare>((file) => Promise.resolve(file));
    };
    const view = renderPage(true, { store, makePrepare });
    const w = t.watermark;
    const card = await screen.findByRole('region', { name: w.title });

    // Not an image: refused.
    const input = screen.getByLabelText(w.choose, { selector: 'input' });
    await user.upload(input, new File(['%PDF'], 'logo.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText(w.badType)).toBeInTheDocument();

    await user.upload(input, new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(screen.getByRole('checkbox', { name: w.enabled })).toBeChecked();
    expect(screen.getByRole('button', { name: w.positions['bottom-right'] })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: w.positions['top-left'] }));
    const size = screen.getByLabelText(w.size);
    fireEvent.change(size, { target: { value: '30' } });
    expect(screen.getByText(w.unsaved)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: w.save }));
    expect(await screen.findByText(w.saved)).toBeInTheDocument();

    const saved = await store.loadWatermark();
    expect(saved).toMatchObject({
      enabled: true,
      position: 'top-left',
      sizePercent: 30,
      opacityPercent: 80,
      marginPercent: 3,
    });
    expect(saved?.image).toBeInstanceOf(Blob);
    await waitFor(() => expect(prepared.at(-1)).toMatchObject({ position: 'top-left' }));
    expect(card).toBeInTheDocument();

    // A reload starts from the saved settings; stopping a sync never clears them.
    view.unmount();
    renderPage(true, { store, makePrepare });
    await screen.findByRole('region', { name: w.title });
    expect(await screen.findByRole('button', { name: w.positions['top-left'] })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: w.remove }));
    expect(await screen.findByText(w.removed)).toBeInTheDocument();
    expect(await store.loadWatermark()).toBeNull();
  });

  it('ADR 0022: the frame mode saves a landscape and a portrait frame', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const store = memorySyncStore();
    const prepared: WatermarkSettings[] = [];
    const makePrepare = (settings: WatermarkSettings) => {
      prepared.push(settings);
      return Promise.resolve<SyncPrepare>((file) => Promise.resolve(file));
    };
    renderPage(true, { store, makePrepare });
    const w = t.watermark;
    await screen.findByRole('region', { name: w.title });

    await user.click(screen.getByRole('radio', { name: w.modes.frame }));
    expect(screen.getByRole('radio', { name: w.modes.frame })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // No frame yet: nothing to save.
    expect(screen.queryByRole('button', { name: w.save })).not.toBeInTheDocument();

    await user.upload(
      screen.getByLabelText(w.frames.framePortrait, { selector: 'input' }),
      new File(['png'], 'portrait.png', { type: 'image/png' }),
    );
    // The logo controls don't apply to a frame.
    expect(screen.queryByLabelText(w.size)).not.toBeInTheDocument();
    await user.upload(
      screen.getByLabelText(w.frames.frameLandscape, { selector: 'input' }),
      new File(['png'], 'landscape.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: w.save }));
    expect(await screen.findByText(w.saved)).toBeInTheDocument();

    const saved = await store.loadWatermark();
    expect(saved).toMatchObject({ enabled: true, mode: 'frame', image: null });
    expect(saved?.frameLandscape).toBeInstanceOf(Blob);
    expect(saved?.framePortrait).toBeInstanceOf(Blob);
    await waitFor(() => expect(prepared.at(-1)).toMatchObject({ mode: 'frame' }));
  });
});
