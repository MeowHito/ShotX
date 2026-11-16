import { ADMIN_ROUTES } from '@shotx/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi, makeUser, makeUserFinance, SELF_ID } from '../../../test/fake-admin-api';
import { renderWithProviders, TEST_PASSWORDS } from '../../../test/render';
import { UserDetail } from './user-detail';

function setup(finance = makeUserFinance()) {
  const photographer = makeUser({ email: 'buyer@example.com' });
  const api = new FakeAdminApi([photographer]);
  api.userFinance.set(photographer.id, finance);
  renderWithProviders(
    <UserDetail userId={photographer.id} currentAdminId={SELF_ID} passwords={TEST_PASSWORDS} />,
    { fetch: api.fetch },
  );
  return { api, photographer };
}

describe('UserDetail finance section (ADR 0027 §4)', () => {
  it('shows purchases, paid (packages, cash, net), estimated cost, profit, usage and orders', async () => {
    const { api, photographer } = setup();
    const paid = await screen.findByTestId('user-finance-paid');
    expect(api.callsOf(ADMIN_ROUTES.userFinance)[0]!.path).toBe(
      `/admin/users/${photographer.id}/finance`,
    );
    expect(screen.getByTestId('user-finance-purchases')).toHaveTextContent('1 ครั้ง');
    expect(screen.getByTestId('user-finance-purchases')).toHaveTextContent(
      'ครั้งแรก 8 พ.ย. 2569 · ล่าสุด 10 พ.ย. 2569',
    );
    expect(paid).toHaveTextContent('฿1,570');
    expect(paid).toHaveTextContent('แพ็กเกจ ฿1,070');
    expect(paid).toHaveTextContent('เงินสด ฿500');
    expect(paid).toHaveTextContent('แพ็กเกจสุทธิไม่รวม VAT ฿1,000');
    const cost = screen.getByTestId('user-finance-cost');
    expect(cost).toHaveTextContent('ประมาณการ');
    expect(cost).toHaveTextContent('฿100');
    expect(cost).toHaveTextContent('พื้นที่จัดเก็บ ฿20');
    expect(cost).toHaveTextContent('เซิร์ฟเวอร์ ฿80');
    const profit = screen.getByTestId('user-finance-profit');
    expect(within(profit).getByText('฿1,400')).not.toHaveClass('text-destructive');
    expect(profit).not.toHaveTextContent('ขาดทุน');

    expect(screen.getByText('3 GB')).toBeInTheDocument();
    expect(screen.getByText('40 GB')).toBeInTheDocument();
    expect(screen.getByText('1,200')).toBeInTheDocument();

    const orders = screen.getByRole('table', { name: 'คำสั่งซื้อแพ็กเกจ' });
    const rows = within(orders).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('7 Days');
    expect(rows[1]).toHaveTextContent('ชำระแล้ว');
    expect(rows[1]).toHaveTextContent('฿1,070');
    expect(rows[1]).toHaveTextContent('฿70');
    expect(rows[2]).toHaveTextContent('รอชำระ');
    expect(rows[2]).toHaveTextContent('–');
  });

  it('a loss-making account shows the profit signed and in red', async () => {
    setup(
      makeUserFinance({
        orders: [],
        ordersPaid: 0,
        paidSatang: 0,
        netPaidSatang: 0,
        cashPaidSatang: 0,
        firstPaidAt: null,
        lastPaidAt: null,
        profitSatang: -10_000,
      }),
    );
    const profit = await screen.findByTestId('user-finance-profit');
    expect(within(profit).getByText('−฿100')).toHaveClass('text-destructive');
    expect(profit).toHaveTextContent('ขาดทุน');
    expect(screen.getByTestId('user-finance-purchases')).toHaveTextContent('ยังไม่เคยชำระ');
    expect(screen.getByText('ยังไม่มีคำสั่งซื้อแพ็กเกจ')).toBeInTheDocument();
  });
});
