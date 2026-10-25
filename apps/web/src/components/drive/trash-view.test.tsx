import { DRIVE_ROUTES, type DriveUsageResponse } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { th } from '@/messages/th';
import { TrashView } from './trash-view';
import { UsageSummary } from './usage-bar';

const TRASHED = '2026-10-20T00:00:00.000Z';

describe('TrashView', () => {
  it('lists top-level trashed items with their purge date and restores the selection', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    const folder = fake.addFolder('Old event', null, TRASHED);
    fake.addFile('inside.jpg', folder.id, { deletedAt: TRASHED });
    const file = fake.addFile('a.jpg', null, { deletedAt: TRASHED });
    fake.addFile('live.jpg');
    renderWithProviders(<TrashView />, { api: apiClientFor(fake.fetch) });

    const list = await screen.findByRole('list', { name: th.trash.title });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).queryByText('inside.jpg')).not.toBeInTheDocument();
    expect(within(list).getAllByText(/^ลบถาวร /)[0]).toHaveTextContent('2569');

    await user.click(screen.getByRole('checkbox', { name: 'เลือก a.jpg' }));
    await user.click(screen.getByRole('button', { name: th.trash.restore }));
    expect(await screen.findByText('กู้คืน 1 รายการแล้ว')).toBeInTheDocument();
    expect(fake.callsTo(DRIVE_ROUTES.restoreItems)[0]?.body).toEqual({
      items: [{ kind: 'file', id: file.id }],
    });
    await waitFor(() => expect(within(list).queryByText('a.jpg')).not.toBeInTheDocument());
  });

  it('empties the trash after confirmation', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.addFile('a.jpg', null, { deletedAt: TRASHED, sizeBytes: 2048 });
    renderWithProviders(<TrashView />, { api: apiClientFor(fake.fetch) });
    await screen.findByText('a.jpg');

    await user.click(screen.getByRole('button', { name: th.trash.emptyTrash }));
    const dialog = await screen.findByRole('dialog', { name: th.trash.confirmTitle });
    expect(fake.callsTo(DRIVE_ROUTES.emptyTrash)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: th.trash.confirm }));

    expect(
      await screen.findByText('ลบถาวร 1 ไฟล์และ 0 โฟลเดอร์ ได้พื้นที่คืน 2 KB'),
    ).toBeInTheDocument();
    expect(await screen.findByText(th.trash.isEmpty)).toBeInTheDocument();
  });
});

describe('UsageSummary', () => {
  const base: DriveUsageResponse = {
    usedBytes: 9 * 1024 ** 3,
    reservedBytes: 512 * 1024 ** 2,
    quotaBytes: 10 * 1024 ** 3,
    availableBytes: 512 * 1024 ** 2,
    trashBytes: 1024 ** 3,
    subscription: { status: 'grace', planCode: 'starter', periodEnd: '2026-11-01T00:00:00.000Z' },
    uploadsBlockedBy: null,
  };

  it('shows used, reserved and trash bytes and the plan', () => {
    renderWithProviders(<UsageSummary usage={base} />, { api: apiClientFor(new FakeApi().fetch) });
    expect(screen.getByText('ใช้ไป 9.5 GB จาก 10 GB')).toBeInTheDocument();
    expect(screen.getByText('กำลังอัปโหลด 512 MB')).toBeInTheDocument();
    expect(screen.getByText('อยู่ในถังขยะ 1 GB')).toBeInTheDocument();
    expect(screen.getByText(/แพ็กเกจ starter · ช่วงผ่อนผัน ถึง/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: th.usage.label })).toBeInTheDocument();
  });

  it.each(['SUBSCRIPTION_INACTIVE', 'QUOTA_EXCEEDED'] as const)(
    'explains uploadsBlockedBy %s in Thai',
    (reason) => {
      renderWithProviders(<UsageSummary usage={{ ...base, uploadsBlockedBy: reason }} />, {
        api: apiClientFor(new FakeApi().fetch),
      });
      expect(screen.getByRole('alert')).toHaveTextContent(th.usage.blocked[reason]);
    },
  );

  it('shows when there is no plan', () => {
    renderWithProviders(<UsageSummary usage={{ ...base, subscription: null, quotaBytes: 0 }} />, {
      api: apiClientFor(new FakeApi().fetch),
    });
    expect(screen.getByText(th.usage.noPlan)).toBeInTheDocument();
  });
});
