import { ADMIN_ROUTES } from '@shotx/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeAdminApi, makeUser } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { ActAsDialog } from './act-as-dialog';

const photographer = makeUser({ email: 'studio@example.com', role: 'photographer' });

describe('ActAsDialog (ADR 0018)', () => {
  it('opens the tab in the click, then sends it to the one-time link', async () => {
    const api = new FakeAdminApi([photographer]);
    const replace = vi.fn();
    const tab = { location: { replace }, close: vi.fn() };
    const openTab = vi.fn(() => tab);
    const onOpened = vi.fn();
    renderWithProviders(
      <ActAsDialog
        user={photographer}
        onOpenChange={vi.fn()}
        onOpened={onOpened}
        openTab={openTab}
      />,
      { fetch: api.fetch },
    );
    expect(screen.getByText(/ทุกการแก้ไขจะถูกบันทึกในชื่อของคุณ/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'เปิดสตูดิโอ' }));
    expect(openTab).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace.mock.calls[0]?.[0]).toMatch(/^https:\/\/.+\/auth\/act-as\?code=/);
    expect(api.callsOf(ADMIN_ROUTES.actAs)).toHaveLength(1);
    expect(onOpened).toHaveBeenCalledWith('เปิดสตูดิโอของ studio@example.com ในแท็บใหม่แล้ว');
  });

  it('shows the link when the browser blocks the new tab', async () => {
    const api = new FakeAdminApi([photographer]);
    renderWithProviders(
      <ActAsDialog
        user={photographer}
        onOpenChange={vi.fn()}
        onOpened={vi.fn()}
        openTab={() => null}
      />,
      { fetch: api.fetch },
    );
    await userEvent.click(screen.getByRole('button', { name: 'เปิดสตูดิโอ' }));
    const link = await screen.findByRole('link', { name: 'เปิดสตูดิโอของ studio@example.com' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toMatch(/\/auth\/act-as\?code=/);
  });
});
