import { BILLING_ROUTES, IDEMPOTENCY_KEY_HEADER } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { UsageBar } from '@/components/drive/usage-bar';
import { createPublicApiClient } from '@/lib/api/client';
import { th } from '@/messages/th';
import { BillingReturn } from './billing-return';
import { BillingView } from './billing-view';
import { PricingTable } from './pricing-table';
import { SubscriptionBanner } from './subscription-banner';

const GiB = 1024 ** 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function renderBilling(fake: FakeApi, options: { initialPlanCode?: string } = {}) {
  const redirect = vi.fn();
  const view = renderWithProviders(
    <BillingView
      pollIntervalMs={5}
      initialPlanCode={options.initialPlanCode}
      testing={{ publicApi: createPublicApiClient({ fetch: fake.fetch }), redirect }}
    />,
    { api: apiClientFor(fake.fetch) },
  );
  return { ...view, redirect };
}

async function choosePlan(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `เลือก ${name}` }));
}

const pay = () => userEvent.click(screen.getByRole('button', { name: th.billing.checkout.pay }));

describe('pricing page', () => {
  it('lists plans from GET /plans in THB with VAT included, monthly and yearly', async () => {
    const fake = new FakeApi();
    const plans = await createPublicApiClient({ fetch: fake.fetch }).call(BILLING_ROUTES.plans);
    renderWithProviders(<PricingTable plans={plans} />, { api: apiClientFor(fake.fetch) });

    const list = screen.getByRole('list', { name: th.pricing.listLabel });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('฿149 / เดือน')).toBeInTheDocument();
    expect(screen.getByText('฿2,290 / เดือน')).toBeInTheDocument();
    expect(screen.getByText('ราคารวมภาษีมูลค่าเพิ่ม 7% แล้ว')).toBeInTheDocument();
    expect(screen.getByText(/ชำระด้วยพร้อมเพย์ล่วงหน้า 1, 3, 6 หรือ 12 เดือน/)).toBeInTheDocument();
    // VAT part of 149 THB as the API split it (9.75 THB).
    expect(screen.getAllByText('รวม VAT ฿9.75')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: th.pricing.yearly }));
    expect(screen.getByText('฿1,490 / ปี')).toBeInTheDocument();
    expect(screen.getByText('฿22,900 / ปี')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'เลือกแพ็กเกจ Pro' })).toHaveAttribute(
      'href',
      '/studio/billing?plan=pro',
    );
    expect(fake.callsTo(BILLING_ROUTES.plans)[0]).toMatchObject({ prefix: '/api' });
  });
});

describe('current subscription', () => {
  it('shows plan, status, quota, period end and renewal mode', async () => {
    const fake = new FakeApi();
    renderBilling(fake);
    const section = await screen.findByRole('region', { name: th.billing.current.heading });
    expect(within(section).getByText('Standard')).toBeInTheDocument();
    expect(within(section).getByText(th.usage.subscriptionStatus.active)).toBeInTheDocument();
    expect(within(section).getByText('50 GB')).toBeInTheDocument();
    expect(within(section).getByText(th.billing.current.modes.prepaid)).toBeInTheDocument();
    expect(
      within(section).queryByRole('button', { name: th.billing.current.cancelAutoRenew }),
    ).not.toBeInTheDocument();
    expect(fake.callsTo(BILLING_ROUTES.subscription)[0]?.prefix).toBe('/bff');
  });

  it('cancels auto-renew after confirming; access runs to period end', async () => {
    const fake = new FakeApi();
    fake.billing.subscription = {
      ...(fake.billing.subscription as NonNullable<typeof fake.billing.subscription>),
      billing: 'auto_renew',
      autoRenewMonths: 1,
    };
    renderBilling(fake);
    expect(await screen.findByText('ต่ออายุอัตโนมัติด้วยบัตรทุกเดือน')).toBeInTheDocument();
    expect(screen.getByText(/ตัดบัตรครั้งถัดไป .+: แพ็กเกจ Standard ฿390/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: th.billing.current.cancelAutoRenew }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(th.billing.current.cancelTitle)).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.billing.current.cancelConfirm }),
    );
    expect(await screen.findByText(th.billing.current.canceledDone)).toBeInTheDocument();
    expect(screen.getByText(/^ยกเลิกการต่ออายุอัตโนมัติแล้ว แพ็กเกจใช้ได้ถึง/)).toBeInTheDocument();
    expect(fake.billing.cancelCalls).toBe(1);
    expect(fake.callsTo(BILLING_ROUTES.cancelSubscription)[0]?.prefix).toBe('/bff');
    expect(
      screen.queryByRole('button', { name: th.billing.current.cancelAutoRenew }),
    ).not.toBeInTheDocument();
  });

  it('shows a pending downgrade and blocks other changes', async () => {
    const fake = new FakeApi({ usedBytes: 20 * GiB });
    fake.billing.subscription = {
      ...(fake.billing.subscription as NonNullable<typeof fake.billing.subscription>),
      pendingChange: { planCode: 'starter', effectiveAt: '2026-12-01T00:00:00.000Z' },
    };
    renderBilling(fake);
    expect(await screen.findByText(/^ลดเป็นแพ็กเกจ Starter \(10 GB\) ตั้งแต่/)).toBeInTheDocument();
    expect(
      screen.getByText(/แพ็กเกจใหม่มีพื้นที่ 10 GB แต่ตอนนี้คุณใช้อยู่ 20 GB \(เกิน 10 GB\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(th.billing.plans.pendingBlocked)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'เลือก Pro' })).toBeDisabled();
  });
});

describe('PromptPay checkout', () => {
  it('renews with a prepaid period, shows the QR drawn from the payload, polls until paid', async () => {
    const fake = new FakeApi();
    fake.billing.options.pollsUntilFinal = 3;
    renderBilling(fake);
    await choosePlan('Standard');
    expect(screen.getByRole('heading', { name: 'ต่ออายุ แพ็กเกจ Standard' })).toBeInTheDocument();
    expect(screen.getByText(th.billing.checkout.explain.renew)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: '3 เดือน · ฿1,170' }));
    await pay();

    // The payload is drawn locally (the gateway gave no image).
    const qr = await screen.findByRole('img', { name: 'QR พร้อมเพย์ ยอด ฿1,170' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByText('ยอดชำระ ฿1,170')).toBeInTheDocument();
    expect(screen.getByText(/^QR นี้ใช้ได้ถึง/)).toBeInTheDocument();

    expect(await screen.findByText(th.billing.payment.paid)).toBeInTheDocument();
    expect(fake.callsTo(BILLING_ROUTES.payment).length).toBeGreaterThanOrEqual(3);
    const [call] = fake.callsTo(BILLING_ROUTES.checkout);
    expect(call?.prefix).toBe('/bff');
    expect(call?.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(UUID);
    expect(call?.body).toEqual({
      planCode: 'standard',
      changeType: 'renew',
      payment: { method: 'promptpay', months: 3 },
    });
    // Paid: the subscription was extended and refetched.
    await waitFor(() =>
      expect(fake.billing.subscription?.periodEnd).toBe('2027-03-01T00:00:00.000Z'),
    );
    // Polling stops once final.
    const polls = fake.callsTo(BILLING_ROUTES.payment).length;
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.callsTo(BILLING_ROUTES.payment)).toHaveLength(polls);
  });

  it('polls to expired, says nothing was charged, and a new attempt gets a new Idempotency-Key', async () => {
    const fake = new FakeApi();
    fake.billing.options.outcome = 'expired';
    renderBilling(fake);
    await choosePlan('Standard');
    await pay();
    expect(await screen.findByText(th.billing.payment.expired)).toBeInTheDocument();
    expect(fake.billing.subscription?.periodEnd).toBe('2026-12-01T00:00:00.000Z');

    await userEvent.click(screen.getByRole('button', { name: th.billing.payment.startOver }));
    await pay();
    expect(await screen.findByText(th.billing.payment.expired)).toBeInTheDocument();
    const keys = fake
      .callsTo(BILLING_ROUTES.checkout)
      .map((c) => c.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("shows the gateway's QR image when the checkout response has one", async () => {
    const fake = new FakeApi();
    fake.billing.options.qrImage = true;
    fake.billing.options.pollsUntilFinal = 1000;
    renderBilling(fake);
    await choosePlan('Standard');
    await pay();
    const qr = await screen.findByRole('img', { name: /^QR พร้อมเพย์/ });
    expect(qr.tagName.toLowerCase()).toBe('img');
    expect(qr).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/) as string);
  });

  it('resumes a pending checkout on CHECKOUT_PENDING with the QR from the polled payment', async () => {
    const fake = new FakeApi();
    fake.billing.options.pollsUntilFinal = 1000;
    const first = renderBilling(fake);
    await choosePlan('Standard');
    await pay();
    await screen.findByRole('img', { name: /^QR พร้อมเพย์/ });
    first.unmount();

    renderBilling(fake);
    await choosePlan('Standard');
    await pay();
    expect(
      await screen.findByText(/มีรายการชำระเงินที่ยังรอชำระอยู่ \(หมดเวลา/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.billing.payment.resume }));
    const qr = await screen.findByRole('img', { name: /^QR พร้อมเพย์/ });
    expect(qr.tagName.toLowerCase()).toBe('svg');
  });
});

describe('card checkout', () => {
  it('redirects to the gateway hosted page and never asks for card numbers', async () => {
    const fake = new FakeApi();
    const { redirect } = renderBilling(fake, { initialPlanCode: 'standard' });
    await screen.findByRole('heading', { name: 'ต่ออายุ แพ็กเกจ Standard' });
    await userEvent.click(
      screen.getByRole('radio', { name: (n: string) => n.startsWith(th.billing.checkout.card) }),
    );
    expect(screen.getByText(th.billing.checkout.cardHint)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'ทุกปี · ฿3,900' }));
    await pay();
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    expect(redirect.mock.calls[0]?.[0]).toMatch(/^https:\/\/pay\.fake-gateway\.test\/card\//);
    expect(screen.getByText(th.billing.payment.redirecting)).toBeInTheDocument();
    expect(fake.callsTo(BILLING_ROUTES.checkout)[0]?.body).toMatchObject({
      payment: { method: 'card', months: 12 },
    });
    expect(document.querySelector('input[autocomplete^="cc-"]')).toBeNull();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('the return page polls the payment until paid', async () => {
    const fake = new FakeApi();
    const { redirect } = renderBilling(fake, { initialPlanCode: 'pro' });
    await screen.findByRole('heading', { name: 'อัปเกรด แพ็กเกจ Pro' });
    await userEvent.click(
      screen.getByRole('radio', { name: (n: string) => n.startsWith(th.billing.checkout.card) }),
    );
    await pay();
    await waitFor(() => expect(redirect).toHaveBeenCalled());
    const paymentId = String(redirect.mock.calls[0]?.[0]).split('/').at(-1) ?? '';

    const navigate = vi.fn();
    renderWithProviders(
      <BillingReturn paymentId={paymentId} pollIntervalMs={5} navigate={navigate} />,
      { api: apiClientFor(fake.fetch) },
    );
    expect(await screen.findByText(th.billing.payment.paid)).toBeInTheDocument();
    expect(fake.billing.subscription).toMatchObject({
      planCode: 'pro',
      billing: 'auto_renew',
      autoRenewMonths: 1,
    });
    await userEvent.click(screen.getByRole('button', { name: th.billing.payment.done }));
    expect(navigate).toHaveBeenCalledWith('/studio/billing');
  });

  it('the return page without a payment id says so', () => {
    const fake = new FakeApi();
    renderWithProviders(<BillingReturn paymentId={null} pollIntervalMs={5} />, {
      api: apiClientFor(fake.fetch),
    });
    expect(screen.getByText(th.billing.return.missing)).toBeInTheDocument();
  });
});

describe('upgrade and downgrade notices', () => {
  it('upgrade: explains immediate effect with proration and charges the difference only', async () => {
    const fake = new FakeApi();
    fake.billing.options.pollsUntilFinal = 1000;
    renderBilling(fake);
    await choosePlan('Pro');
    expect(screen.getByRole('heading', { name: 'อัปเกรด แพ็กเกจ Pro' })).toBeInTheDocument();
    expect(screen.getByText(th.billing.checkout.explain.upgrade)).toBeInTheDocument();
    expect(screen.getByText(th.billing.checkout.upgradeAmount)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /เดือน ·/ })).not.toBeInTheDocument();
    await pay();
    // 37 started days left of 30-day months: (990 - 390) x 37 / 30 = 740 THB.
    expect(await screen.findByText('ยอดชำระ ฿740')).toBeInTheDocument();
    expect(screen.getByText('ส่วนต่าง 37 วันที่เหลือในรอบนี้')).toBeInTheDocument();
    expect(fake.callsTo(BILLING_ROUTES.checkout)[0]?.body).toMatchObject({
      changeType: 'upgrade',
      payment: { method: 'promptpay', months: null },
    });
  });

  it('downgrade: applies at period end, warns about quota, never deletes; card needs auto-renew', async () => {
    const fake = new FakeApi({ usedBytes: 20 * GiB });
    fake.billing.options.pollsUntilFinal = 1000;
    renderBilling(fake);
    await choosePlan('Starter');
    expect(screen.getByRole('heading', { name: 'ลดแพ็กเกจ แพ็กเกจ Starter' })).toBeInTheDocument();
    expect(screen.getByText(/^การลดแพ็กเกจมีผลเมื่อครบรอบปัจจุบัน \(.+\)/)).toBeInTheDocument();
    expect(screen.getByText(/ระบบจะไม่ลบไฟล์ของคุณ/)).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: (n: string) => n.startsWith(th.billing.checkout.card) }),
    ).toBeDisabled();
    expect(screen.getByText(th.billing.checkout.cardUnavailableDowngrade)).toBeInTheDocument();
    await pay();
    expect(
      await screen.findByText(
        /แพ็กเกจใหม่มีพื้นที่ 10 GB แต่ตอนนี้คุณใช้อยู่ 20 GB \(เกิน 10 GB\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('ยอดชำระ ฿149')).toBeInTheDocument();
  });

  it('card downgrade on auto-renew is scheduled without a charge', async () => {
    const fake = new FakeApi();
    fake.billing.subscription = {
      ...(fake.billing.subscription as NonNullable<typeof fake.billing.subscription>),
      billing: 'auto_renew',
      autoRenewMonths: 12,
    };
    renderBilling(fake);
    await choosePlan('Starter');
    await userEvent.click(
      screen.getByRole('radio', { name: (n: string) => n.startsWith(th.billing.checkout.card) }),
    );
    expect(screen.getByText(th.billing.checkout.cardDowngradeNote)).toBeInTheDocument();
    await pay();
    expect(await screen.findByText(/^ตั้งเวลาลดแพ็กเกจแล้ว มีผลตั้งแต่/)).toBeInTheDocument();
    expect(fake.billing.payments.size).toBe(0);
    expect(fake.billing.subscription?.pendingChange?.planCode).toBe('starter');
  });

  it('a stale change type is refused with a Thai reason', async () => {
    const fake = new FakeApi();
    renderBilling(fake);
    await choosePlan('Pro');
    // The subscription expired in the meantime: Pro is now `new`, not `upgrade`.
    fake.billing.subscription = {
      ...(fake.billing.subscription as NonNullable<typeof fake.billing.subscription>),
      status: 'expired',
    };
    await pay();
    expect(await screen.findByText(th.errors.planChange.change_type_mismatch)).toBeInTheDocument();
  });
});

describe('banners and usage link', () => {
  function renderBanner(fake: FakeApi) {
    return renderWithProviders(<SubscriptionBanner />, { api: apiClientFor(fake.fetch) });
  }

  it('grace: renew by the end of grace, with a link to billing', async () => {
    const fake = new FakeApi();
    fake.billing.subscription = {
      ...(fake.billing.subscription as NonNullable<typeof fake.billing.subscription>),
      status: 'grace',
    };
    renderBanner(fake);
    // Grace ends 14 days after period end (1 Dec 2026): 15 Dec 2026, in the Thai calendar.
    const banner = await screen.findByText(/ต่ออายุภายใน 15 ธ\.ค\. 2569/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.billing.banners.renew })).toHaveAttribute(
      'href',
      '/studio/billing',
    );
  });

  it('trial and expired banners; nothing while active', async () => {
    const fake = new FakeApi();
    const sub = fake.billing.subscription as NonNullable<typeof fake.billing.subscription>;
    fake.billing.subscription = { ...sub, status: 'trial', planCode: 'trial' };
    const trial = renderBanner(fake);
    expect(await screen.findByText(/^คุณกำลังทดลองใช้ฟรีถึง/)).toBeInTheDocument();
    trial.unmount();

    fake.billing.subscription = { ...sub, status: 'expired' };
    const expired = renderBanner(fake);
    expect(
      await screen.findByText(/^แพ็กเกจหมดอายุแล้ว ลิงก์แชร์ทั้งหมดเปิดไม่ได้/),
    ).toBeInTheDocument();
    expired.unmount();

    fake.billing.subscription = sub;
    renderBanner(fake);
    await waitFor(() => expect(fake.callsTo(BILLING_ROUTES.subscription)).toHaveLength(3));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the usage bar links to billing', async () => {
    const fake = new FakeApi();
    renderWithProviders(<UsageBar />, { api: apiClientFor(fake.fetch) });
    expect(await screen.findByRole('link', { name: th.usage.manage })).toHaveAttribute(
      'href',
      '/studio/billing',
    );
  });
});
