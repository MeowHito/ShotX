import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { OverviewPage, percentOf } from './overview-page';

describe('OverviewPage (ADR 0016)', () => {
  it('shows the server, the R2 bucket by prefix and what the system records', async () => {
    const api = new FakeAdminApi();
    renderWithProviders(<OverviewPage />, { fetch: api.fetch });

    const server = await screen.findByRole('region', { name: 'เซิร์ฟเวอร์ (VPS)' });
    expect(within(server).getByText('12.5%')).toBeInTheDocument();
    expect(within(server).getByRole('meter', { name: 'CPU' })).toHaveAttribute(
      'aria-valuenow',
      '12.5',
    );
    expect(within(server).getByText('75%')).toBeInTheDocument();
    // 380 of 400 GB: 95%, shown in red.
    const disk = within(server).getByRole('meter', { name: 'ดิสก์' });
    expect(disk).toHaveAttribute('aria-valuenow', '95');
    expect(disk.firstElementChild).toHaveClass('bg-destructive');
    expect(within(server).getByText('2 วัน 5 ชม.')).toBeInTheDocument();
    expect(within(server).getByText(/ไม่มีเซ็นเซอร์/)).toBeInTheDocument();

    const bucket = screen.getByRole('region', { name: 'Cloudflare R2' });
    expect(within(bucket).getByText('ไฟล์ต้นฉบับ')).toBeInTheDocument();
    expect(within(bucket).getByText('รูปย่อและพรีวิว')).toBeInTheDocument();
    expect(within(bucket).getByText(/ไม่มีเพดานพื้นที่/)).toBeInTheDocument();

    const storage = screen.getByRole('region', { name: 'ข้อมูลในระบบ' });
    expect(within(storage).getByText('54,321')).toBeInTheDocument();
  });

  it('says when R2 could not be counted', async () => {
    const api = new FakeAdminApi();
    api.system = { ...api.system, bucket: null };
    renderWithProviders(<OverviewPage />, { fetch: api.fetch });
    expect(await screen.findByText(/อ่านขนาดใน R2 ไม่ได้/)).toBeInTheDocument();
  });

  it('computes shares safely', () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(9, 4)).toBe(100);
  });
});
