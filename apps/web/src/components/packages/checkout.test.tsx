import {
  ErrorCode,
  PACKAGE_CHECKOUT_RETURN_PATH,
  PACKAGES_SECTION_PATH,
  type PackageOrderView,
} from '@shotx/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { navigateTo } from '@/lib/browser/navigate';
import { PACKAGE_ORDER_PATHS } from '@/lib/packages/paths';
import { th } from '@/messages/th';
import { SignupConfirmForm } from '../auth/signup-confirm-form';
import { CheckoutReturn } from './checkout-return';
import { FakeCheckout } from './fake-checkout';

// ADR 0026: /checkout/return, the test gateway's page and /signup/confirm.

vi.mock('@/lib/browser/navigate', () => ({ navigateTo: vi.fn() }));
const navigate = vi.mocked(navigateTo);

beforeEach(() => {
  navigate.mockReset();
});

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
const apiError = (status: number, code: ErrorCode) => json(status, { code, message: code });

function order(overrides: Partial<PackageOrderView> = {}): PackageOrderView {
  return {
    status: 'pending',
    packageCode: 'd7',
    packageName: '7 Days',
    totalSatang: 64_093,
    emailMasked: 's***@example.com',
    accountCreated: false,
    expiresAt: null,
    ...overrides,
  };
}

/** A fetch that answers each call with the next response (the last one repeats). */
function sequence(...responses: (() => Response)[]) {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = (input) => {
    paths.push(input as string);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return Promise.resolve((next as () => Response)());
  };
  return { fetch, paths };
}

const PAID_AT = '2026-11-23T05:00:00.000Z';

/** PACKAGE_ORDER_POLL_INTERVAL_SECONDS / _TIMEOUT_SECONDS (the defaults: 3 s, 2 min). */
const INTERVAL = 3000;
const TIMEOUT = 120_000;

describe('/checkout/return: polling (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets `ms` pass, running the polls due and the answers they get. */
  const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('polls every interval while pending, then says the set-password link went to the masked email', async () => {
    const { fetch, paths } = sequence(
      () => json(200, order()),
      () => json(200, order()),
      () => json(200, order({ status: 'paid', accountCreated: true, expiresAt: PAID_AT })),
    );
    renderIntl(<CheckoutReturn hasOrder intervalMs={INTERVAL} timeoutMs={TIMEOUT} fetch={fetch} />);
    expect(screen.getByRole('status')).toHaveTextContent(th.checkout.pending);
    await pass(0);
    expect(paths).toHaveLength(1);
    await pass(INTERVAL - 1);
    expect(paths).toHaveLength(1);
    await pass(1);
    expect(paths).toHaveLength(2);
    await pass(INTERVAL);
    expect(screen.getByText('ส่งลิงก์ตั้งรหัสผ่านไปที่ s***@example.com แล้ว')).toBeInTheDocument();
    await pass(INTERVAL * 5);
    expect(paths).toEqual([
      PACKAGE_ORDER_PATHS.order,
      PACKAGE_ORDER_PATHS.order,
      PACKAGE_ORDER_PATHS.order,
    ]);
    expect(screen.getByRole('heading', { name: th.checkout.paidTitle })).toBeInTheDocument();
    expect(screen.getByText('แพ็กเกจ 7 Days')).toBeInTheDocument();
    expect(screen.getByText('ยอดชำระ ฿640.93')).toBeInTheDocument();
    expect(screen.getByText(/^ใช้ได้ถึง /)).toHaveTextContent('2569');
    // A new account signs in through the emailed link, not the studio link.
    expect(screen.queryByRole('link', { name: th.checkout.goStudio })).toBeNull();
  });

  it('gives up after the timeout, and "check again" polls once more', async () => {
    let answer = () => json(200, order());
    const { fetch, paths } = sequence(() => answer());
    renderIntl(
      <CheckoutReturn hasOrder intervalMs={INTERVAL} timeoutMs={INTERVAL * 3} fetch={fetch} />,
    );
    await pass(INTERVAL * 3);
    // Polls at 0, 3, 6 and 9 s; none would end before the timeout after that.
    expect(screen.getByText(th.checkout.timeout)).toBeInTheDocument();
    expect(paths).toHaveLength(4);
    await pass(INTERVAL * 10);
    expect(paths).toHaveLength(4);
    answer = () => json(200, order({ status: 'paid', expiresAt: PAID_AT }));
    fireEvent.click(screen.getByRole('button', { name: th.checkout.checkAgain }));
    await pass(0);
    expect(screen.getByText(th.checkout.added)).toBeInTheDocument();
    expect(paths).toHaveLength(5);
  });

  it('keeps polling through a network error', async () => {
    const { fetch, paths } = sequence(
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => json(200, order({ status: 'paid', expiresAt: PAID_AT })),
    );
    renderIntl(<CheckoutReturn hasOrder intervalMs={INTERVAL} timeoutMs={TIMEOUT} fetch={fetch} />);
    await pass(0);
    expect(screen.queryByText(th.checkout.added)).toBeNull();
    await pass(INTERVAL);
    expect(screen.getByText(th.checkout.added)).toBeInTheDocument();
    expect(paths).toHaveLength(2);
  });
});

describe('/checkout/return: results', () => {
  it('paid for an existing account: "package added" and a link to the studio', async () => {
    const { fetch } = sequence(() => json(200, order({ status: 'paid', expiresAt: PAID_AT })));
    renderIntl(<CheckoutReturn hasOrder intervalMs={5} timeoutMs={5000} fetch={fetch} />);
    expect(await screen.findByText(th.checkout.added)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.checkout.goStudio })).toHaveAttribute(
      'href',
      '/studio',
    );
  });

  it.each([
    ['failed', th.checkout.failedTitle],
    ['amount_mismatch', th.checkout.mismatchTitle],
  ] as const)('%s: try again from the packages, and contact the team', async (status, title) => {
    const { fetch } = sequence(() => json(200, order({ status })));
    renderIntl(<CheckoutReturn hasOrder intervalMs={5} timeoutMs={5000} fetch={fetch} />);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.checkout.retry })).toHaveAttribute(
      'href',
      PACKAGES_SECTION_PATH,
    );
    expect(screen.getByText(th.checkout.contact)).toBeInTheDocument();
  });

  it('no order cookie: a generic message, without asking anything', () => {
    const { fetch, paths } = sequence(() => json(500, {}));
    renderIntl(<CheckoutReturn hasOrder={false} intervalMs={5} timeoutMs={5000} fetch={fetch} />);
    expect(screen.getByRole('heading', { name: th.checkout.notFoundTitle })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.checkout.backToPackages })).toHaveAttribute(
      'href',
      PACKAGES_SECTION_PATH,
    );
    expect(paths).toEqual([]);
  });

  it('ORDER_NOT_FOUND: the same generic message', async () => {
    const { fetch } = sequence(() => apiError(404, ErrorCode.ORDER_NOT_FOUND));
    renderIntl(<CheckoutReturn hasOrder intervalMs={5} timeoutMs={5000} fetch={fetch} />);
    expect(
      await screen.findByRole('heading', { name: th.checkout.notFoundTitle }),
    ).toBeInTheDocument();
  });
});

describe('/checkout/fake (PACKAGE_GATEWAY=fake)', () => {
  const ORDER_ID = crypto.randomUUID();

  it('sends the chosen result for the order, then goes to the return page', async () => {
    const sent: unknown[] = [];
    const fetch: typeof globalThis.fetch = (_input, init) => {
      sent.push(JSON.parse(init?.body as string));
      return Promise.resolve(json(200, order({ status: 'failed' })));
    };
    renderIntl(<FakeCheckout orderId={ORDER_ID} fetch={fetch} />);
    await userEvent.click(screen.getByRole('button', { name: th.checkout.fake.failed }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(PACKAGE_CHECKOUT_RETURN_PATH));
    expect(sent).toEqual([{ orderId: ORDER_ID, result: 'failed' }]);
  });

  it('shows the API error when the fake gateway is off', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(apiError(404, ErrorCode.NOT_FOUND));
    renderIntl(<FakeCheckout orderId={ORDER_ID} fetch={fetch} />);
    await userEvent.click(screen.getByRole('button', { name: th.checkout.fake.paid }));
    expect(await screen.findByRole('alert')).toHaveTextContent(th.errors.codes.NOT_FOUND);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('/signup/confirm', () => {
  const TOKEN = 'b'.repeat(43);
  const PASSWORD = 'my-own-Secret-77';

  function recorder(respond: () => Response) {
    const sent: { path: string; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      sent.push({ path: input as string, body: JSON.parse(init?.body as string) as unknown });
      return Promise.resolve(respond());
    };
    return { sent, fetch };
  }

  async function fill(password = PASSWORD, confirm = password) {
    await userEvent.type(screen.getByLabelText(th.password.newPassword), password);
    await userEvent.type(screen.getByLabelText(th.password.confirm), confirm);
    await userEvent.click(screen.getByRole('button', { name: th.signup.save }));
  }

  it('creates the account with the link token and goes to the studio', async () => {
    const { sent, fetch } = recorder(() => new Response(null, { status: 204 }));
    renderIntl(<SignupConfirmForm minLength={10} fetch={fetch} initialHash={`#token=${TOKEN}`} />);
    expect(screen.getByRole('heading', { name: th.signup.title })).toBeInTheDocument();
    await fill();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/studio'));
    expect(sent).toEqual([
      { path: '/auth/signup/confirm', body: { token: TOKEN, password: PASSWORD } },
    ]);
  });

  it('checks the password policy and the confirmation before sending', async () => {
    const { sent, fetch } = recorder(() => new Response(null, { status: 204 }));
    renderIntl(<SignupConfirmForm minLength={10} fetch={fetch} initialHash={`#token=${TOKEN}`} />);
    await fill('short');
    expect(screen.getByRole('alert')).toHaveTextContent('อย่างน้อย 10 ตัวอักษร');
    await userEvent.clear(screen.getByLabelText(th.password.newPassword));
    await userEvent.clear(screen.getByLabelText(th.password.confirm));
    await fill(PASSWORD, `${PASSWORD}x`);
    expect(screen.getByRole('alert')).toHaveTextContent(th.password.mismatch);
    expect(sent).toEqual([]);
  });

  it('SIGNUP_LINK_INVALID: says so and links back to the packages', async () => {
    const { fetch } = recorder(() => apiError(400, ErrorCode.SIGNUP_LINK_INVALID));
    renderIntl(<SignupConfirmForm minLength={10} fetch={fetch} initialHash={`#token=${TOKEN}`} />);
    await fill();
    expect(await screen.findByText(th.signup.linkInvalid)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: th.signup.backToPackages })).toHaveAttribute(
      'href',
      PACKAGES_SECTION_PATH,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a link without a token is invalid at once', () => {
    renderIntl(<SignupConfirmForm minLength={10} initialHash="" />);
    expect(screen.getByText(th.signup.linkInvalid)).toBeInTheDocument();
  });
});
