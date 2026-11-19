import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeApi, shareItem } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { renderSharePage } from '../../../test/share-harness';
import { th } from '@/messages/th';
import { PrintOrdersPage } from './print-page';

const tp = th.share.print;
const ts = th.printStudio;

vi.mock('photoswipe', () => ({ default: class {} }));

function shareWithPhotos(fake: FakeApi) {
  return fake.addPublicShare({
    items: [
      shareItem('ภาพ 1.jpg'),
      shareItem('ภาพ 2.jpg'),
      shareItem('คลิป.mp4', { mediaKind: 'video' }),
    ],
  });
}

describe('share page: print orders (ADR 0031)', () => {
  it('shows no printer button while the photographer has print orders off', async () => {
    const fake = new FakeApi();
    const share = shareWithPhotos(fake);
    renderSharePage(fake, share.token);
    await screen.findByRole('button', { name: th.share.open.replace('{name}', 'ภาพ 1.jpg') });
    await waitFor(() =>
      expect(fake.calls.some((c) => c.path.endsWith(`/s/${share.token}/prints`))).toBe(true),
    );
    expect(screen.queryByRole('button', { name: /สั่งพิมพ์/ })).not.toBeInTheDocument();
  });

  it('orders a print on a chosen size with a name, then counts the device down to its limit', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.prints.settings = {
      enabled: true,
      approval: 'manual',
      perDeviceLimit: 1,
      paperSizes: ['4r', 'a4'],
    };
    const share = shareWithPhotos(fake);
    renderSharePage(fake, share.token);

    const printPhoto1 = await screen.findByRole('button', {
      name: tp.button.replace('{name}', 'ภาพ 1.jpg'),
    });
    // Photos only: no printer on the video.
    expect(
      screen.queryByRole('button', { name: tp.button.replace('{name}', 'คลิป.mp4') }),
    ).not.toBeInTheDocument();

    await user.click(printPhoto1);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('สั่งได้อีก 1 จาก 1 รูป')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: tp.sizes.a4 }));
    await user.type(within(dialog).getByLabelText(tp.name), 'บิบ 77');
    await user.click(within(dialog).getByRole('button', { name: tp.submit }));

    expect(await within(dialog).findByText('เลขคำสั่งพิมพ์ #1')).toBeInTheDocument();
    expect(within(dialog).getByText(tp.waitApproval)).toBeInTheDocument();
    expect(fake.prints.orders[0]).toMatchObject({
      paperSize: 'a4',
      customerName: 'บิบ 77',
      status: 'pending',
    });
    const create = fake.calls.find(
      (c) => c.method === 'POST' && c.path.endsWith(`/s/${share.token}/prints`),
    );
    // Public route: straight to /api with the browser's cookies, never through the BFF.
    expect(create?.prefix).toBe('/api');
    await user.click(within(dialog).getByRole('button', { name: tp.close }));

    // The ordered photo's button is marked, and the device has no prints left.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: tp.button.replace('{name}', 'ภาพ 1.jpg') }),
      ).toHaveAttribute('title', tp.ordered),
    );
    await user.click(
      screen.getByRole('button', { name: tp.button.replace('{name}', 'ภาพ 2.jpg') }),
    );
    const second = await screen.findByRole('dialog');
    expect(within(second).getByText('สั่งพิมพ์ครบ 1 รูปแล้ว')).toBeInTheDocument();
    expect(within(second).getByRole('button', { name: tp.submit })).toBeDisabled();
  });

  it('shows the API refusal in Thai (e.g. the size was just switched off)', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.prints.settings = {
      enabled: true,
      approval: 'auto',
      perDeviceLimit: 5,
      paperSizes: ['5r'],
    };
    const share = shareWithPhotos(fake);
    renderSharePage(fake, share.token);
    await user.click(
      await screen.findByRole('button', { name: tp.button.replace('{name}', 'ภาพ 1.jpg') }),
    );
    const dialog = await screen.findByRole('dialog');
    fake.prints.settings = { ...fake.prints.settings, paperSizes: ['a4'] };
    await user.click(within(dialog).getByRole('button', { name: tp.submit }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      th.errors.codes.PRINT_SIZE_UNAVAILABLE,
    );
  });
});

describe('studio: print orders page (ADR 0031)', () => {
  function renderPage(fake: FakeApi, print = vi.fn(() => Promise.resolve())) {
    renderWithProviders(<PrintOrdersPage print={print} />, { api: apiClientFor(fake.fetch) });
    return print;
  }

  it('saves the settings: on, approval, limit per device and paper sizes', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    renderPage(fake);
    expect(await screen.findByText(ts.disabledNotice)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: new RegExp(ts.settings.enabled) }));
    await user.click(screen.getByRole('radio', { name: new RegExp(ts.settings.auto) }));
    const limit = screen.getByLabelText(ts.settings.limit);
    await user.clear(limit);
    await user.type(limit, '3');
    await user.click(screen.getByRole('checkbox', { name: tp.sizes['6r'] }));
    await user.click(screen.getByRole('button', { name: ts.settings.save }));
    await waitFor(() =>
      expect(fake.prints.settings).toEqual({
        enabled: true,
        approval: 'auto',
        perDeviceLimit: 3,
        paperSizes: ['4r', '6r'],
      }),
    );
    await waitFor(() => expect(screen.queryByText(ts.disabledNotice)).not.toBeInTheDocument());
    // The form keeps its "saved" note after the settings come back (no remount).
    expect(screen.getByRole('status')).toHaveTextContent(ts.settings.saved);
  });

  it('refuses to save without a paper size', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    renderPage(fake);
    await user.click(await screen.findByRole('checkbox', { name: tp.sizes['4r'] }));
    expect(screen.getByText(ts.settings.sizesRequired)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ts.settings.save })).toBeDisabled();
  });

  it('allows, declines and prints orders from the list', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.prints.settings = {
      enabled: true,
      approval: 'manual',
      perDeviceLimit: 2,
      paperSizes: ['4r'],
    };
    const a = fake.prints.add({ customerName: 'สมชาย' });
    const b = fake.prints.add({ customerName: null });
    const print = renderPage(fake);

    const rowA = (await screen.findByText('สมชาย')).closest('li') as HTMLElement;
    expect(within(rowA).getByText('#1')).toBeInTheDocument();
    await user.click(within(rowA).getByRole('button', { name: ts.actions.approve }));
    await waitFor(() =>
      expect(fake.prints.orders.find((o) => o.id === a.id)?.status).toBe('queued'),
    );

    const rowB = screen.getByText(ts.order.noName).closest('li') as HTMLElement;
    await user.click(within(rowB).getByRole('button', { name: ts.actions.reject }));
    await waitFor(() =>
      expect(fake.prints.orders.find((o) => o.id === b.id)?.status).toBe('rejected'),
    );

    await user.click(screen.getByRole('tab', { name: new RegExp(ts.tabs.queued) }));
    const queued = (await screen.findByText('สมชาย')).closest('li') as HTMLElement;
    await user.click(within(queued).getByRole('button', { name: ts.actions.print }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print).toHaveBeenCalledWith(a.printUrl, '4r', expect.objectContaining({ id: a.id }));
    expect(fake.prints.orders.find((o) => o.id === a.id)).toMatchObject({
      status: 'printed',
      printCount: 1,
    });
  });

  it('as the print station, prints queued orders oldest first, one at a time', async () => {
    const user = userEvent.setup();
    const fake = new FakeApi();
    fake.prints.settings = {
      enabled: true,
      approval: 'auto',
      perDeviceLimit: 5,
      paperSizes: ['4r'],
    };
    const first = fake.prints.add({ status: 'queued' });
    const second = fake.prints.add({ status: 'queued', paperSize: '4r' });
    let release: () => void = () => undefined;
    const print = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderPage(fake, print);
    await user.click(await screen.findByRole('checkbox', { name: new RegExp(ts.station.title) }));

    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print).toHaveBeenLastCalledWith(
      first.printUrl,
      '4r',
      expect.objectContaining({ id: first.id }),
    );
    expect(screen.getByText('กำลังพิมพ์ #1')).toBeInTheDocument();
    // The second waits for the first to finish.
    expect(print).toHaveBeenCalledTimes(1);
    await act(() => {
      release();
      return Promise.resolve();
    });
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2), { timeout: 8_000 });
    expect(print).toHaveBeenLastCalledWith(
      second.printUrl,
      '4r',
      expect.objectContaining({ id: second.id }),
    );
    // Taken as queued only (a second station would get CONFLICT).
    const takes = fake.calls.filter((c) => c.path.endsWith('/print'));
    expect(takes.every((c) => (c.body as { onlyQueued: boolean }).onlyQueued)).toBe(true);
    await act(() => {
      release();
      return Promise.resolve();
    });
  }, 15_000);
});
