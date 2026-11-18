import { ErrorCode, PACKAGE_CHECKOUT_RETURN_PATH, type PackageOrderView } from '@shotx/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { navigateTo } from '@/lib/browser/navigate';
import { PACKAGE_ORDER_PATHS } from '@/lib/packages/paths';
import { th } from '@/messages/th';
import { CheckoutReturn } from './checkout-return';
import { PayCheckout } from './pay-checkout';

// ADR 0029: Snap's own pay page for mPAY (PromptPay QR shown here, or the hosted card form).

vi.mock('@/lib/browser/navigate', () => ({ navigateTo: vi.fn() }));
const navigate = vi.mocked(navigateTo);

const ORDER_ID = '0190a0a0-0000-7000-8000-000000000001';
const QR = 'data:image/png;base64,iVBORw0KGgo=';
const INTERVAL = 3000;

function renderIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider
      locale={DEFAULT_LOCALE}
      messages={MESSAGES[DEFAULT_LOCALE]}
      timeZone={TIME_ZONE}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function order(overrides: Partial<PackageOrderView> = {}): PackageOrderView {
  return {
    status: 'pending',
    packageCode: 'd3',
    packageName: '3 Days',
    totalSatang: 42_693,
    emailMasked: 'b***@example.test',
    accountCreated: false,
    expiresAt: null,
    paymentMethods: ['qr', 'card'],
    coupon: null,
    ...overrides,
  };
}

/** Answers GET /checkout/order with `orders()` and POST pay with `payment()`; records calls. */
function api(orders: () => Response, payment: () => Response = () => json(500, {})) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: input instanceof Request ? input.url : input.toString(),
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return Promise.resolve(method === 'GET' ? orders() : payment());
  };
  return { fetch, calls };
}

beforeEach(() => {
  navigate.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('/checkout/pay', () => {
  it('shows the total and the methods, then a QR polled until paid', async () => {
    let current = order();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const { fetch, calls } = api(
      () => json(200, current),
      () => json(200, { method: 'qr', qrImage: QR, expiresAt }),
    );
    renderIntl(<PayCheckout orderId={ORDER_ID} intervalMs={INTERVAL} fetch={fetch} />);
    expect(await screen.findByText('฿426.93')).toBeInTheDocument();
    expect(screen.getByText('แพ็กเกจ 3 Days')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual([th.checkout.pay.methods.qr, th.checkout.pay.methods.card]);

    fireEvent.click(screen.getByRole('button', { name: th.checkout.pay.methods.qr }));
    const image = await screen.findByRole('img', { name: th.checkout.pay.qrAlt });
    expect(image).toHaveAttribute('src', QR);
    expect(screen.getByText(/QR หมดอายุใน 10:00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.checkout.pay.qrSave })).toHaveAttribute('href', QR);
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: PACKAGE_ORDER_PATHS.pay,
      body: { orderId: ORDER_ID, method: 'qr' },
    });

    const polls = () => calls.filter((c) => c.method === 'GET').length;
    const before = polls();
    await pass(INTERVAL);
    expect(polls()).toBeGreaterThan(before);
    current = order({ status: 'paid', paymentMethods: [] });
    await pass(INTERVAL);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(PACKAGE_CHECKOUT_RETURN_PATH));
  });

  it('an expired QR offers a new one', async () => {
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    const { fetch, calls } = api(
      () => json(200, order()),
      () => json(200, { method: 'qr', qrImage: QR, expiresAt }),
    );
    renderIntl(<PayCheckout orderId={ORDER_ID} intervalMs={INTERVAL} fetch={fetch} />);
    fireEvent.click(await screen.findByRole('button', { name: th.checkout.pay.methods.qr }));
    await screen.findByRole('img', { name: th.checkout.pay.qrAlt });
    await pass(6_000);
    expect(screen.getByText(th.checkout.pay.qrExpired)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: th.checkout.pay.qrNew }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
  });

  it('goes to the card form', async () => {
    const form = 'https://pay.mpay.example.test/form/1';
    const { fetch } = api(
      () => json(200, order()),
      () => json(200, { method: 'card', redirectUrl: form }),
    );
    renderIntl(<PayCheckout orderId={ORDER_ID} intervalMs={INTERVAL} fetch={fetch} />);
    fireEvent.click(await screen.findByRole('button', { name: th.checkout.pay.methods.card }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(form));
  });

  it('shows the gateway error and stays on the choice', async () => {
    const { fetch } = api(
      () => json(200, order()),
      () => json(502, { code: ErrorCode.PAYMENT_GATEWAY_ERROR, message: 'x' }),
    );
    renderIntl(<PayCheckout orderId={ORDER_ID} intervalMs={INTERVAL} fetch={fetch} />);
    fireEvent.click(await screen.findByRole('button', { name: th.checkout.pay.methods.qr }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      th.errors.codes.PAYMENT_GATEWAY_ERROR,
    );
    expect(screen.getByRole('button', { name: th.checkout.pay.methods.card })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a paid order goes to the return page; one without methods says it can not be paid', async () => {
    const paid = api(() => json(200, order({ status: 'paid', paymentMethods: [] })));
    renderIntl(<PayCheckout orderId={ORDER_ID} intervalMs={INTERVAL} fetch={paid.fetch} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(PACKAGE_CHECKOUT_RETURN_PATH));

    const none = api(() => json(200, order({ paymentMethods: [] })));
    renderIntl(<PayCheckout orderId={ORDER_ID} intervalMs={INTERVAL} fetch={none.fetch} />);
    expect(await screen.findByText(th.checkout.pay.unavailable)).toBeInTheDocument();
  });
});

describe('/checkout/return with a payable order', () => {
  it('offers to pay again while the order is still pending', async () => {
    const { fetch } = api(() => json(200, order()));
    renderIntl(<CheckoutReturn hasOrder intervalMs={INTERVAL} timeoutMs={60_000} fetch={fetch} />);
    expect(await screen.findByRole('link', { name: th.checkout.payAgain })).toHaveAttribute(
      'href',
      '/checkout/pay',
    );
  });
});
