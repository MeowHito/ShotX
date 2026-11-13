import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { monthlyTotal, OverviewPage, percentOf } from './overview-page';

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

    // Monthly cost: R2 $2.10 (≈ ฿69), VPS ฿1,529 (≈ $46.33), total ฿1,598 (≈ $48.43).
    expect(within(bucket).getByText('$2.10/เดือน')).toBeInTheDocument();
    expect(within(bucket).getByText('≈ ฿69')).toBeInTheDocument();
    expect(within(bucket).getByText(/ฟรี 10 GB แรก/)).toBeInTheDocument();
    expect(within(server).getByText('฿1,529/เดือน')).toBeInTheDocument();
    expect(within(server).getByText('≈ $46.33')).toBeInTheDocument();
    expect(within(server).getByText(/ไม่ได้เก็บบนเซิร์ฟเวอร์/)).toBeInTheDocument();
    expect(screen.getByText('ค่าใช้จ่ายรวมโดยประมาณ ฿1,598/เดือน (≈ $48.43)')).toBeInTheDocument();

    const storage = screen.getByRole('region', { name: 'ข้อมูลในระบบ' });
    expect(within(storage).getByText('54,321')).toBeInTheDocument();
  });

  it('says when R2 could not be counted, and totals the VPS alone', async () => {
    const api = new FakeAdminApi();
    api.system = {
      ...api.system,
      bucket: null,
      cost: { ...api.system.cost, r2StorageUsdMonth: null },
    };
    renderWithProviders(<OverviewPage />, { fetch: api.fetch });
    expect(await screen.findByText(/อ่านขนาดใน R2 ไม่ได้/)).toBeInTheDocument();
    expect(screen.getByText('ค่าใช้จ่ายรวมโดยประมาณ ฿1,529/เดือน (≈ $46.33)')).toBeInTheDocument();
  });

  it('a prepaid VPS (0 a month) says paid and only R2 counts; R2 under the free GB says why it is $0', async () => {
    const api = new FakeAdminApi();
    api.system = {
      ...api.system,
      bucket:
        api.system.bucket === null ? null : { ...api.system.bucket, totalBytes: 2.5 * 1024 ** 3 },
      cost: { ...api.system.cost, vpsThbMonth: 0, r2StorageUsdMonth: 0 },
    };
    renderWithProviders(<OverviewPage />, { fetch: api.fetch });
    const server = await screen.findByRole('region', { name: 'เซิร์ฟเวอร์ (VPS)' });
    expect(within(server).getByText('จ่ายรายปีแล้ว')).toBeInTheDocument();
    expect(within(server).getByText('ไม่มีค่าใช้จ่ายรายเดือน')).toBeInTheDocument();
    const bucket = screen.getByRole('region', { name: 'Cloudflare R2' });
    expect(within(bucket).getByText('$0.00/เดือน')).toBeInTheDocument();
    expect(within(bucket).getAllByText('ยังอยู่ในโควตาฟรี').length).toBeGreaterThan(0);
    expect(within(bucket).getByText(/ใช้ 2\.5.*จากที่ฟรี 10 GB/)).toBeInTheDocument();
    expect(within(bucket).getByRole('meter', { name: 'ยังอยู่ในโควตาฟรี' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(screen.getByText('ค่าใช้จ่ายรวมโดยประมาณ ฿0/เดือน (≈ $0.00)')).toBeInTheDocument();
  });

  it('totals the month in baht and dollars', () => {
    const total = monthlyTotal({
      usdThb: 33,
      r2StorageUsdMonth: 1,
      r2FreeStorageGb: 10,
      vpsThbMonth: 1529,
    });
    expect(total.thb).toBe(1562);
    expect(total.usd).toBeCloseTo(47.33, 2);
  });

  it('computes shares safely', () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(9, 4)).toBe(100);
  });
});
