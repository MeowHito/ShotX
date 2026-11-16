import { ADMIN_ROUTES, type AdminExpense } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BarSeriesOption } from 'echarts/charts';
import { describe, expect, it } from 'vitest';
import { optionOf } from '../../../test/echarts-mock';
import { FakeAdminApi, makeFinance, SELF_ID } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { CHART_PALETTE } from '@/lib/charts/theme';
import { FinancePage } from './finance-page';

const TODAY = '2026-11-16';

function expense(overrides: Partial<AdminExpense> = {}): AdminExpense {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    spentOn: '2026-11-15',
    amountSatang: 152_900,
    category: 'server',
    note: 'ค่า VPS',
    recordedById: SELF_ID,
    createdAt: '2026-11-15T05:00:00.000Z',
    ...overrides,
  };
}

function setup(api = new FakeAdminApi()) {
  const user = userEvent.setup();
  renderWithProviders(<FinancePage today={TODAY} />, { fetch: api.fetch });
  return { api, user };
}

describe('FinancePage (ADR 0027)', () => {
  it('asks for the last 30 days by day and shows the tiles, a loss signed and in red', async () => {
    const { api } = setup();
    expect(await screen.findByTestId('tile-income')).toHaveTextContent('฿3,710');
    const call = api.callsOf(ADMIN_ROUTES.finance)[0]!;
    expect(Object.fromEntries(call.search)).toEqual({
      from: '2026-10-18',
      to: TODAY,
      bucket: 'day',
    });
    expect(screen.getByTestId('tile-income')).toHaveTextContent('สุทธิไม่รวม VAT ฿3,500');
    expect(screen.getByTestId('tile-income')).toHaveTextContent('แพ็กเกจ ฿3,210 · เงินสด ฿500');
    expect(screen.getByTestId('tile-expense')).toHaveTextContent('฿3,800');
    expect(screen.getByTestId('tile-expense')).toHaveTextContent('บันทึก ฿3,500 · ประมาณการ ฿300');
    const profit = screen.getByTestId('tile-profit');
    expect(profit).toHaveTextContent('−฿300');
    expect(profit).toHaveTextContent('ขาดทุน');
    expect(within(profit).getByText('−฿300')).toHaveClass('text-destructive');
    expect(screen.getByTestId('tile-orders')).toHaveTextContent('3');
    expect(screen.getByTestId('tile-orders')).toHaveTextContent('สร้างบัญชีจากการซื้อ 1');
    expect(screen.getByTestId('tile-buyers')).toHaveTextContent('2');
    expect(screen.getByTestId('tile-free')).toHaveTextContent('4');
    expect(screen.getByTestId('finance-range')).toHaveTextContent('18 ต.ค. 2569 – 16 พ.ย. 2569');
  });

  it('a gain is shown without a minus sign or red', async () => {
    const api = new FakeAdminApi();
    const f = makeFinance();
    api.finance = {
      ...f,
      totals: { ...f.totals, manualExpenseSatang: 0, expenseSatang: 30_000, profitSatang: 320_000 },
    };
    setup(api);
    const profit = await screen.findByTestId('tile-profit');
    const value = within(profit).getByText('฿3,200');
    expect(value).not.toHaveClass('text-destructive');
    expect(value.textContent).not.toContain('−');
    expect(profit).not.toHaveTextContent('ขาดทุน');
  });

  it('gives each chart its series and colours, and a table view', async () => {
    const { user } = setup();
    await screen.findByTestId('tile-income');
    await waitFor(() => expect(() => optionOf('รายรับเทียบรายจ่าย')).not.toThrow());
    const ie = optionOf('รายรับเทียบรายจ่าย').series as BarSeriesOption[];
    expect(ie.map((s) => [s.name, s.itemStyle?.color])).toEqual([
      ['รายรับ', CHART_PALETTE.light.income],
      ['รายจ่ายที่บันทึก', CHART_PALETTE.light.expense],
      ['ค่าใช้จ่ายระบบ (ประมาณการ)', CHART_PALETTE.light.expense],
    ]);
    const profit = optionOf('กำไรต่อช่วง').series as BarSeriesOption[];
    expect(profit.map((s) => s.itemStyle?.color)).toEqual([
      CHART_PALETTE.light.income,
      CHART_PALETTE.light.critical,
    ]);
    const mix = optionOf('สัดส่วนแพ็กเกจ').series as BarSeriesOption[];
    expect(mix).toHaveLength(1);

    const card = screen.getByRole('region', { name: 'รายรับเทียบรายจ่าย' });
    await user.click(within(card).getByRole('button', { name: 'ดูเป็นตาราง' }));
    const table = within(card).getByRole('table', { name: 'รายรับเทียบรายจ่าย' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent('16 พ.ย. 2569');
    expect(rows[3]).toHaveTextContent('฿2,140');
    expect(rows[3]).toHaveTextContent('฿3,100');
    expect(within(card).queryByRole('img')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'ดูเป็นกราฟ' }));
    expect(within(card).getByRole('img', { name: 'รายรับเทียบรายจ่าย' })).toBeInTheDocument();

    // Package mix by income.
    const mixCard = screen.getByRole('region', { name: 'สัดส่วนแพ็กเกจ' });
    await user.click(within(mixCard).getByRole('button', { name: 'รายรับ (รวม VAT)' }));
    const mixIncome = optionOf('สัดส่วนแพ็กเกจ').series as BarSeriesOption[];
    expect((mixIncome[0]!.data as { value: number }[]).map((d) => d.value)).toEqual([
      214_000, 107_000,
    ]);

    // Top customers link to their user page.
    expect(screen.getByRole('link', { name: 'big@example.com' })).toHaveAttribute(
      'href',
      '/users/00000000-0000-4000-8000-0000000000c1',
    );
  });

  it('switches presets and bucket; a too long range by day is refused', async () => {
    const { api, user } = setup();
    await screen.findByTestId('tile-income');
    await user.click(screen.getByRole('button', { name: 'ปีนี้' }));
    await waitFor(() =>
      expect(Object.fromEntries(api.callsOf(ADMIN_ROUTES.finance).at(-1)!.search)).toEqual({
        from: '2026-01-01',
        to: TODAY,
        bucket: 'month',
      }),
    );
    await user.click(screen.getByRole('button', { name: '7 วัน' }));
    await waitFor(() =>
      expect(Object.fromEntries(api.callsOf(ADMIN_ROUTES.finance).at(-1)!.search)).toMatchObject({
        from: '2026-11-10',
        bucket: 'day',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'เดือน' }));
    await waitFor(() =>
      expect(api.callsOf(ADMIN_ROUTES.finance).at(-1)!.search.get('bucket')).toBe('month'),
    );

    await user.click(screen.getByRole('button', { name: 'กำหนดเอง' }));
    await user.clear(screen.getByLabelText('ตั้งแต่'));
    await user.type(screen.getByLabelText('ตั้งแต่'), '2026-11-12');
    await user.click(screen.getByRole('button', { name: 'ใช้ช่วงนี้' }));
    await waitFor(() =>
      expect(Object.fromEntries(api.callsOf(ADMIN_ROUTES.finance).at(-1)!.search)).toEqual({
        from: '2026-11-12',
        to: TODAY,
        bucket: 'month',
      }),
    );
    // The ledger follows the range.
    expect(Object.fromEntries(api.callsOf(ADMIN_ROUTES.listExpenses).at(-1)!.search)).toEqual({
      from: '2026-11-12',
      to: TODAY,
    });

    await user.clear(screen.getByLabelText('ตั้งแต่'));
    await user.type(screen.getByLabelText('ตั้งแต่'), '2025-01-01');
    await user.click(screen.getByRole('button', { name: 'ใช้ช่วงนี้' }));
    await user.click(screen.getByRole('button', { name: 'วัน' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ไม่เกิน 366 วัน');
  });

  it('validates the expense form and sends baht as satang after a confirm', async () => {
    const { api, user } = setup();
    await screen.findByTestId('tile-income');
    const form = screen.getByRole('form', { name: 'เพิ่มรายจ่าย' });
    await user.click(within(form).getByRole('button', { name: 'เพิ่มรายจ่าย' }));
    expect(
      within(form).getByText('กรุณาใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง'),
    ).toBeInTheDocument();
    expect(within(form).getByText('กรุณาเลือกหมวด')).toBeInTheDocument();

    await user.type(within(form).getByLabelText('จำนวนเงิน (บาท)'), '0');
    await user.click(within(form).getByRole('button', { name: 'เพิ่มรายจ่าย' }));
    expect(within(form).getByText('จำนวนเงินต้องมากกว่า 0 บาท')).toBeInTheDocument();

    const date = within(form).getByLabelText('วันที่จ่าย');
    await user.clear(date);
    await user.type(date, '2026-11-18');
    await user.clear(within(form).getByLabelText('จำนวนเงิน (บาท)'));
    await user.type(within(form).getByLabelText('จำนวนเงิน (บาท)'), '1,529.29');
    await user.selectOptions(within(form).getByLabelText('หมวด'), 'เซิร์ฟเวอร์');
    await user.click(within(form).getByRole('button', { name: 'เพิ่มรายจ่าย' }));
    expect(within(form).getByText('วันที่จ่ายต้องไม่เกินพรุ่งนี้')).toBeInTheDocument();
    expect(api.callsOf(ADMIN_ROUTES.createExpense)).toHaveLength(0);

    await user.clear(date);
    await user.type(date, '2026-11-17');
    await user.type(within(form).getByLabelText('หมายเหตุ (ไม่บังคับ)'), '  ค่า VPS  ');
    await user.click(within(form).getByRole('button', { name: 'เพิ่มรายจ่าย' }));
    const dialog = await screen.findByRole('dialog', { name: 'บันทึกรายจ่าย ฿1,529.29?' });
    expect(dialog).toHaveTextContent('หมวดเซิร์ฟเวอร์ วันที่ 17 พ.ย. 2569');
    expect(api.callsOf(ADMIN_ROUTES.createExpense)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'ยืนยันบันทึก' }));
    await waitFor(() => expect(api.callsOf(ADMIN_ROUTES.createExpense)).toHaveLength(1));
    expect(api.callsOf(ADMIN_ROUTES.createExpense)[0]!.body).toEqual({
      spentOn: '2026-11-17',
      amountSatang: 152_929,
      category: 'server',
      note: 'ค่า VPS',
    });
    expect(await screen.findByText('บันทึกรายจ่าย ฿1,529.29 แล้ว')).toBeInTheDocument();
    // The summary is refetched.
    await waitFor(() => expect(api.callsOf(ADMIN_ROUTES.finance).length).toBeGreaterThan(1));
  });

  it('deletes an expense only after a confirm', async () => {
    const api = new FakeAdminApi();
    api.expenses = [
      expense(),
      expense({
        id: '00000000-0000-4000-8000-0000000000e2',
        category: 'marketing',
        amountSatang: 50_000,
        note: null,
        spentOn: '2026-11-01',
      }),
    ];
    const { user } = setup(api);
    const table = await screen.findByRole('table', { name: 'รายการรายจ่าย' });
    expect(within(table).getByText('ค่า VPS')).toBeInTheDocument();
    expect(within(table).getByText('การตลาด')).toBeInTheDocument();
    expect(screen.getByText('รวมที่แสดงอยู่ ฿2,029')).toBeInTheDocument();

    await user.click(
      within(table).getByRole('button', { name: 'ลบรายจ่าย ฿1,529 วันที่ 15 พ.ย. 2569' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'ลบรายจ่าย ฿1,529?' });
    await user.click(within(dialog).getByRole('button', { name: 'ยกเลิก' }));
    expect(api.callsOf(ADMIN_ROUTES.deleteExpense)).toHaveLength(0);

    await user.click(
      within(table).getByRole('button', { name: 'ลบรายจ่าย ฿1,529 วันที่ 15 พ.ย. 2569' }),
    );
    const again = await screen.findByRole('dialog', { name: 'ลบรายจ่าย ฿1,529?' });
    await user.click(within(again).getByRole('button', { name: 'ลบรายจ่าย' }));
    await waitFor(() => expect(api.callsOf(ADMIN_ROUTES.deleteExpense)).toHaveLength(1));
    expect(api.callsOf(ADMIN_ROUTES.deleteExpense)[0]!.path).toBe(
      '/admin/expenses/00000000-0000-4000-8000-0000000000e1',
    );
    expect(await screen.findByText('ลบรายจ่าย ฿1,529 แล้ว')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('ค่า VPS')).toBeNull());
  });
});
