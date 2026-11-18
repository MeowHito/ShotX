import { ADMIN_ROUTES, type AdminCoupon } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi, SELF_ID } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { th } from '@/messages/th';
import { CouponForm, CouponsPage, couponState, endOfBangkokDay } from './coupons-page';

// ADR 0030: the admin coupons page.

const t = th.coupons;

function coupon(overrides: Partial<AdminCoupon> = {}): AdminCoupon {
  return {
    id: '0192f000-0000-7000-8000-000000000001',
    code: 'TEST99',
    percentOff: 99,
    maxRedemptions: 2,
    paidCount: 1,
    holdingCount: 0,
    expiresAt: null,
    isActive: true,
    note: null,
    createdById: SELF_ID,
    createdAt: '2026-11-18T07:00:00.000Z',
    updatedAt: '2026-11-18T07:00:00.000Z',
    ...overrides,
  };
}

describe('coupon helpers', () => {
  it('ends a coupon at the end of the Bangkok day', () => {
    expect(endOfBangkokDay('2026-11-30')).toBe('2026-11-30T16:59:59.999Z');
  });

  it('says off, expired, used up or active, in that order', () => {
    const now = Date.parse('2026-11-18T08:00:00Z');
    expect(couponState(coupon(), now)).toBe('active');
    expect(couponState(coupon({ paidCount: 1, holdingCount: 1 }), now)).toBe('usedUp');
    expect(couponState(coupon({ expiresAt: '2026-11-18T07:59:59.000Z' }), now)).toBe('expired');
    expect(couponState(coupon({ isActive: false, paidCount: 2 }), now)).toBe('inactive');
  });
});

describe('CouponsPage', () => {
  it('creates a coupon after confirming, upper-casing the code', async () => {
    const api = new FakeAdminApi();
    renderWithProviders(<CouponForm today="2026-11-18" />, { fetch: api.fetch });
    const form = screen.getByRole('form', { name: t.add });
    await userEvent.type(within(form).getByLabelText(t.code), 'test99');
    await userEvent.type(within(form).getByLabelText(t.percent), '99');
    await userEvent.clear(within(form).getByLabelText(t.maxRedemptions));
    await userEvent.type(within(form).getByLabelText(t.maxRedemptions), '3');
    await userEvent.click(within(form).getByRole('button', { name: t.submit }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('สร้างคูปอง TEST99?');
    expect(dialog).toHaveTextContent('ลด 99% ใช้ได้ 3 ครั้ง · ไม่หมดอายุ');
    await userEvent.click(within(dialog).getByRole('button', { name: t.confirm }));
    await waitFor(() => expect(api.coupons).toHaveLength(1));
    expect(api.callsOf(ADMIN_ROUTES.createCoupon).at(-1)?.body).toEqual({
      code: 'TEST99',
      percentOff: 99,
      maxRedemptions: 3,
    });
  });

  it('refuses a bad percent or code without calling the API', async () => {
    const api = new FakeAdminApi();
    renderWithProviders(<CouponForm today="2026-11-18" />, { fetch: api.fetch });
    const form = screen.getByRole('form', { name: t.add });
    await userEvent.type(within(form).getByLabelText(t.code), 'a b');
    await userEvent.type(within(form).getByLabelText(t.percent), '101');
    await userEvent.click(within(form).getByRole('button', { name: t.submit }));
    expect(screen.getByText(t.codeInvalid)).toBeInTheDocument();
    expect(screen.getByText(t.percentInvalid)).toBeInTheDocument();
    expect(api.callsOf(ADMIN_ROUTES.createCoupon)).toHaveLength(0);
  });

  it('lists coupons with their uses and switches one off', async () => {
    const api = new FakeAdminApi();
    api.coupons = [coupon({ holdingCount: 1, maxRedemptions: 5 })];
    renderWithProviders(<CouponsPage />, { fetch: api.fetch });
    const row = (await screen.findByText('TEST99')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('99%');
    expect(row).toHaveTextContent('2 / 5');
    expect(row).toHaveTextContent('รอชำระ 1');
    expect(row).toHaveTextContent(t.status.active);
    await userEvent.click(within(row).getByRole('button', { name: t.disable }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: t.disable }));
    await waitFor(() => expect(api.coupons[0]?.isActive).toBe(false));
    expect(api.callsOf(ADMIN_ROUTES.updateCoupon).at(-1)?.body).toEqual({ isActive: false });
  });
});
