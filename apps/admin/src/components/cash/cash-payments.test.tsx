import { ADMIN_ROUTES, ErrorCode, IDEMPOTENCY_KEY_HEADER } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi, makeUser } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { CashPaymentForm, CashPayments } from './cash-payments';

const photographer = makeUser({ email: 'photo@example.com', name: 'ช่างภาพ เอ' });

async function record(
  user: ReturnType<typeof userEvent.setup>,
  amount: string,
  { date, note }: { date?: string; note?: string } = {},
) {
  await user.clear(screen.getByLabelText('จำนวนเงิน (บาท)'));
  await user.type(screen.getByLabelText('จำนวนเงิน (บาท)'), amount);
  if (date !== undefined) {
    await user.clear(screen.getByLabelText('วันที่รับเงิน'));
    await user.type(screen.getByLabelText('วันที่รับเงิน'), date);
  }
  if (note !== undefined) await user.type(screen.getByLabelText('หมายเหตุ (ไม่บังคับ)'), note);
  await user.click(screen.getByRole('button', { name: 'บันทึกรับเงิน' }));
}

describe('cash payments', () => {
  it('records baht as integer satang after a confirmation, with an Idempotency-Key', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([photographer]);
    renderWithProviders(<CashPayments photographer={photographer} />, { fetch: api.fetch });
    expect(await screen.findByText('ยังไม่มีรายการรับเงินสด')).toBeInTheDocument();

    await record(user, '1,500.50', { note: ' เงินสดหน้างาน ' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('บันทึกรับเงินสด ฿1,500.50?')).toBeInTheDocument();
    expect(api.callsOf(ADMIN_ROUTES.createCashPayment)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'ยืนยันบันทึก' }));

    expect(await screen.findByText('บันทึกรับเงิน ฿1,500.50 แล้ว')).toBeInTheDocument();
    const [call] = api.callsOf(ADMIN_ROUTES.createCashPayment);
    expect(call!.body).toMatchObject({
      photographerId: photographer.id,
      amountSatang: 150_050,
      note: 'เงินสดหน้างาน',
    });
    expect((call!.body as { paidAt: string }).paidAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T00:00:00\+07:00$/,
    );
    expect(call!.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    // The list refreshes with the new row, shown in baht.
    const table = await screen.findByRole('table', { name: 'รายการรับเงินสด' });
    expect(within(table).getByText('฿1,500.50')).toBeInTheDocument();
    expect(within(table).getByText('เงินสดหน้างาน')).toBeInTheDocument();
    expect(screen.getByLabelText('จำนวนเงิน (บาท)')).toHaveValue('');

    // The next payment gets a new key.
    await record(user, '200');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'ยืนยันบันทึก' }),
    );
    await screen.findByText('บันทึกรับเงิน ฿200 แล้ว');
    const keys = api
      .callsOf(ADMIN_ROUTES.createCashPayment)
      .map((c) => c.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(new Set(keys).size).toBe(2);
  });

  it('reuses the key when retrying after a failure without an answer', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([photographer]);
    api.failNext(ADMIN_ROUTES.createCashPayment, ErrorCode.INTERNAL_ERROR);
    renderWithProviders(<CashPaymentForm photographer={photographer} today="2026-11-10" />, {
      fetch: api.fetch,
    });
    await record(user, '990');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'ยืนยันบันทึก' }));
    expect(await within(dialog).findByText('ระบบขัดข้อง กรุณาลองใหม่ภายหลัง')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'ยืนยันบันทึก' }));
    await screen.findByText('บันทึกรับเงิน ฿990 แล้ว');
    const [first, second] = api.callsOf(ADMIN_ROUTES.createCashPayment);
    expect(second!.headers[IDEMPOTENCY_KEY_HEADER]).toBe(first!.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(first!.body).toEqual({
      photographerId: photographer.id,
      amountSatang: 99_000,
      paidAt: '2026-11-10T00:00:00+07:00',
    });
    expect(api.payments).toHaveLength(1);
  });

  it('checks the amount, the date and the note before asking to confirm', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([photographer]);
    renderWithProviders(<CashPaymentForm photographer={photographer} today="2026-11-10" />, {
      fetch: api.fetch,
    });
    await record(user, '12.345');
    expect(
      screen.getByText('กรุณาใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง'),
    ).toBeInTheDocument();
    await record(user, '0');
    expect(screen.getByText('จำนวนเงินต้องมากกว่า 0 บาท')).toBeInTheDocument();
    await record(user, '30000000');
    expect(screen.getByText(/จำนวนเงินต้องไม่เกิน ฿21,474,836.47 ต่อรายการ/)).toBeInTheDocument();
    await record(user, '100', { date: '2026-11-11' });
    expect(screen.getByText('วันที่รับเงินต้องไม่เป็นวันในอนาคต')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('cancelling the confirmation records nothing', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([photographer]);
    renderWithProviders(<CashPaymentForm photographer={photographer} today="2026-11-10" />, {
      fetch: api.fetch,
    });
    await record(user, '500');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'ยกเลิก' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls).toHaveLength(0);
  });
});
