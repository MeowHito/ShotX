import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarNav } from '@/components/studio/sidebar-nav';
import type { ClientFolderSyncConfig } from '@/lib/server/config';
import type { SyncDirectoryHandle } from '@/lib/sync/fs-access';
import { memorySyncStore } from '@/lib/sync/store';
import { th } from '@/messages/th';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { FolderSyncProvider } from './folder-sync-context';
import { FolderSyncPage } from './folder-sync-page';

const CONFIG: ClientFolderSyncConfig = {
  intervalMs: 60_000,
  settleMs: 0,
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

function renderPage(supported: boolean) {
  const api = new FakeApi({ role: 'photographer' });
  return renderWithProviders(
    <FolderSyncProvider config={CONFIG} testing={{ store: memorySyncStore(), supported }}>
      <SidebarNav pathname="/studio/sync" />
      <FolderSyncPage />
    </FolderSyncProvider>,
    { api: apiClientFor(api.fetch) },
  );
}

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
});
