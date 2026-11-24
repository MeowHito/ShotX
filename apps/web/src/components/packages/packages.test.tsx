import {
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  packageTotal,
  type PackagesResponse,
  type PublicPackage,
} from '@shotx/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { navigateTo } from '@/lib/browser/navigate';
import { PACKAGE_ORDER_PATHS } from '@/lib/packages/paths';
import { th } from '@/messages/th';
import { FakeTurnstile } from '../../../test/fake-turnstile';
import { FeatureGrid } from './feature-grid';
import { PackageCards } from './package-cards';
import { packageDialogMode } from './package-dialog';

// ADR 0026: the home page's package cards and the dialog behind "เลือกแพ็กเกจนี้".

vi.mock('@/lib/browser/navigate', () => ({ navigateTo: vi.fn() }));
const navigate = vi.mocked(navigateTo);

const VAT = 700;

function pkg(
  code: string,
  name: string,
  days: number,
  photoLimit: number,
  priceSatang: number,
): PublicPackage {
  return {
    code,
    name,
    kind: 'plan',
    days,
    photoLimit,
    featured: code === 'd7',
    free: code === 'free',
    price: packageTotal(priceSatang, VAT),
  };
}

/** The seeded packages of migration 0016, as GET /packages answers them. */
const PACKAGES = [
  pkg('free', 'Free', 3, 100, 0),
  pkg('d3', '3 Days', 3, 1000, 39_900),
  pkg('d7', '7 Days', 7, 3000, 59_900),
  pkg('d15', '15 Days', 15, 5000, 79_900),
  pkg('d30', '30 Days', 30, 10_000, 129_900),
];

function response(sales: Partial<PackagesResponse['sales']> = {}): PackagesResponse {
  return {
    packages: PACKAGES,
    currency: 'THB',
    vatRateBasisPoints: VAT,
    sales: { salesEnabled: true, featuredCode: 'd7', onlinePayment: true, ...sales },
  };
}

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

interface Sent {
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Stubs the browser's fetch: records each request and answers with `respond`. */
function stubFetch(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Sent = {
      path: input as string,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    sent.push(call);
    return Promise.resolve(respond(call));
  });
  return sent;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const apiError = (status: number, code: ErrorCode) => json(status, { code, message: code });

function card(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name, level: 3 });
  return heading.closest('li') as HTMLElement;
}

async function choose(name: string) {
  await userEvent.click(within(card(name)).getByRole('button', { name: th.home.choose }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  navigate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('home page package cards', () => {
  it('renders the five cards from GET /packages: VAT-exclusive price, days, photos', () => {
    renderIntl(<PackageCards data={response()} signedIn={false} />);
    const cards = within(screen.getByRole('list', { name: th.home.packagesLabel })).getAllByRole(
      'listitem',
    );
    expect(cards).toHaveLength(5);
    expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual([
      'Free',
      '3 Days',
      '7 Days',
      '15 Days',
      '30 Days',
    ]);
    const d3 = card('3 Days');
    expect(d3).toHaveTextContent('฿399');
    expect(d3).toHaveTextContent('1,000 ภาพ');
    expect(d3).toHaveTextContent(th.home.photosLabel);
    expect(d3).toHaveTextContent(th.home.who.d3);
    expect(card('30 Days')).toHaveTextContent('฿1,299');
    expect(card('Free')).toHaveTextContent('฿0');
    // The featured card (PACKAGES_FEATURED_CODE): only 7 Days.
    expect(cards.map((c) => c.dataset.featured)).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(card('7 Days')).toHaveTextContent(th.home.featured);
    expect(
      screen.getByText('ราคายังไม่รวม VAT 7% · ชำระครั้งเดียวตามระยะเวลาที่เลือก'),
    ).toBeInTheDocument();
  });

  it('says so when no package is on sale', () => {
    renderIntl(<PackageCards data={{ ...response(), packages: [] }} signedIn={false} />);
    expect(screen.getByText(th.home.empty)).toBeInTheDocument();
  });

  it('lists the seven features of every package', () => {
    renderIntl(<FeatureGrid />);
    expect(screen.getByRole('heading', { name: th.home.featuresTitle })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(
      Object.values(th.home.features).map((f) => f.title),
    );
  });
});

describe('package dialog modes', () => {
  it('free, paid, coming soon or contact the team, from the sales switches', () => {
    const [free, d7] = [PACKAGES[0], PACKAGES[2]] as [PublicPackage, PublicPackage];
    const on = response().sales;
    expect(packageDialogMode(free, on)).toBe('free');
    expect(packageDialogMode(d7, on)).toBe('paid');
    expect(packageDialogMode(d7, { ...on, onlinePayment: false })).toBe('soon');
    expect(packageDialogMode(free, { ...on, onlinePayment: false })).toBe('free');
    const off = { ...on, salesEnabled: false, onlinePayment: false };
    expect(packageDialogMode(free, off)).toBe('contact');
    expect(packageDialogMode(d7, off)).toBe('contact');
  });
});

describe('Free sign-up dialog', () => {
  it('sends name and email to web, then says the link was sent', async () => {
    const sent = stubFetch(() => new Response(null, { status: 204 }));
    renderIntl(<PackageCards data={response()} signedIn={false} />);
    const dialog = await choose('Free');
    expect(dialog).toHaveTextContent('แพ็กเกจ Free · ไม่มีค่าใช้จ่าย');
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.freeSubmit }),
    );
    // Checked before sending.
    expect(within(dialog).getByRole('alert')).toHaveTextContent(th.packageDialog.nameMissing);
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.name), 'สมชาย');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.email), 'not-an-email');
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.freeSubmit }),
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent(th.packageDialog.emailInvalid);
    expect(sent).toHaveLength(0);

    await userEvent.clear(within(dialog).getByLabelText(th.packageDialog.email));
    await userEvent.type(
      within(dialog).getByLabelText(th.packageDialog.email),
      'somchai@example.com',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.freeSubmit }),
    );
    expect(await screen.findByText(th.packageDialog.freeSentTitle)).toBeInTheDocument();
    expect(sent).toEqual([
      expect.objectContaining({
        path: AUTH_PATHS.signupFree,
        method: 'POST',
        body: { name: 'สมชาย', email: 'somchai@example.com' },
      }),
    ]);
    expect(screen.getByRole('dialog')).toHaveTextContent('somchai@example.com');
  });

  it('maps RATE_LIMITED to Thai, and sign-up switched off to "contact the team"', async () => {
    let answer = apiError(429, ErrorCode.RATE_LIMITED);
    stubFetch(() => answer);
    renderIntl(<PackageCards data={response()} signedIn={false} />);
    const dialog = await choose('Free');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.name), 'Somchai');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.email), 'a@example.com');
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.freeSubmit }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      th.errors.codes.RATE_LIMITED,
    );
    answer = apiError(403, ErrorCode.FEATURE_DISABLED);
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.freeSubmit }),
    );
    expect(await within(dialog).findByText(th.packageDialog.contactTeam)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: th.packageDialog.freeSubmit })).toBeNull();
  });
});

describe('paid package dialog', () => {
  it('shows price, VAT and total, asks name and email, and goes to the gateway', async () => {
    const sent = stubFetch(() =>
      json(200, { redirectUrl: 'https://pay.example.com/checkout/abc' }),
    );
    renderIntl(<PackageCards data={response()} signedIn={false} />);
    const dialog = await choose('3 Days');
    expect(dialog).toHaveTextContent('แพ็กเกจ 3 Days');
    expect(dialog).toHaveTextContent('3 วัน · อัปโหลดได้สูงสุด 1,000 ภาพ');
    const summary = dialog.querySelector('dl');
    expect(summary).toHaveTextContent('ราคาแพ็กเกจ฿399');
    expect(summary).toHaveTextContent('VAT 7%฿27.93');
    expect(summary).toHaveTextContent('ยอดชำระ฿426.93');

    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.name), 'Somchai');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.email), 'a@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://pay.example.com/checkout/abc'),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      path: PACKAGE_ORDER_PATHS.order,
      method: 'POST',
      body: { packageCode: 'd3', name: 'Somchai', email: 'a@example.com' },
    });
    expect(sent[0]?.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(/^[!-~]{1,255}$/);
  });

  it('keeps one Idempotency-Key per dialog: a retry after a lost answer is the same order', async () => {
    let fail = true;
    const sent = stubFetch(() => {
      if (fail) {
        fail = false;
        return apiError(502, ErrorCode.INTERNAL_ERROR);
      }
      return json(200, { redirectUrl: 'https://pay.example.com/x' });
    });
    renderIntl(<PackageCards data={response()} signedIn />);
    const dialog = await choose('7 Days');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      th.errors.codes.INTERNAL_ERROR,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://pay.example.com/x'));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers[IDEMPOTENCY_KEY_HEADER]).toBe(sent[1]?.headers[IDEMPOTENCY_KEY_HEADER]);
  });

  it('a changed name or email is a new order: a new Idempotency-Key', async () => {
    let fail = true;
    const sent = stubFetch(() => {
      if (fail) {
        fail = false;
        return apiError(502, ErrorCode.INTERNAL_ERROR);
      }
      return json(200, { redirectUrl: 'https://pay.example.com/z' });
    });
    renderIntl(<PackageCards data={response()} signedIn={false} />);
    const dialog = await choose('3 Days');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.name), 'Somchai');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.email), 'a@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await within(dialog).findByRole('alert');
    await userEvent.clear(within(dialog).getByLabelText(th.packageDialog.email));
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.email), 'b@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://pay.example.com/z'));
    expect(sent.map((c) => (c.body as { email: string }).email)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(sent[0]?.headers[IDEMPOTENCY_KEY_HEADER]).not.toBe(
      sent[1]?.headers[IDEMPOTENCY_KEY_HEADER],
    );
  });

  it('IDEMPOTENCY_KEY_REUSED: tries once more with a new key', async () => {
    let reused = true;
    const sent = stubFetch(() => {
      if (reused) {
        reused = false;
        return apiError(409, ErrorCode.IDEMPOTENCY_KEY_REUSED);
      }
      return json(200, { redirectUrl: 'https://pay.example.com/r' });
    });
    renderIntl(<PackageCards data={response()} signedIn />);
    const dialog = await choose('7 Days');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://pay.example.com/r'));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers[IDEMPOTENCY_KEY_HEADER]).not.toBe(
      sent[1]?.headers[IDEMPOTENCY_KEY_HEADER],
    );
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('signed in: no name or email, the order is for the account', async () => {
    const sent = stubFetch(() => json(200, { redirectUrl: 'https://pay.example.com/y' }));
    renderIntl(<PackageCards data={response()} signedIn />);
    const dialog = await choose('15 Days');
    expect(within(dialog).queryByLabelText(th.packageDialog.email)).toBeNull();
    expect(dialog).toHaveTextContent(th.packageDialog.paidSignedIn);
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sent[0]?.body).toEqual({ packageCode: 'd15' });
  });

  it('online payment off: "coming soon, contact the team" and a disabled pay button', async () => {
    const sent = stubFetch(() => json(500, {}));
    renderIntl(<PackageCards data={response({ onlinePayment: false })} signedIn={false} />);
    const dialog = await choose('7 Days');
    expect(dialog).toHaveTextContent(th.packageDialog.paymentSoon);
    expect(dialog).toHaveTextContent('ยอดชำระ฿640.93');
    expect(within(dialog).getByRole('button', { name: th.packageDialog.pay })).toBeDisabled();
    expect(within(dialog).queryByLabelText(th.packageDialog.email)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('PAYMENT_UNAVAILABLE from the API turns the dialog into "coming soon"', async () => {
    stubFetch(() => apiError(409, ErrorCode.PAYMENT_UNAVAILABLE));
    renderIntl(<PackageCards data={response()} signedIn />);
    const dialog = await choose('30 Days');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    expect(await within(dialog).findByText(th.packageDialog.paymentSoon)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: th.packageDialog.pay })).toBeDisabled();
  });

  it('sales off: every package says "contact the team"', async () => {
    renderIntl(
      <PackageCards
        data={response({ salesEnabled: false, onlinePayment: false })}
        signedIn={false}
      />,
    );
    let dialog = await choose('Free');
    expect(dialog).toHaveTextContent(th.packageDialog.contactTeam);
    expect(within(dialog).queryByRole('button', { name: th.packageDialog.freeSubmit })).toBeNull();
    await userEvent.click(
      within(dialog).getAllByRole('button', { name: th.packageDialog.close })[0] as HTMLElement,
    );
    dialog = await choose('3 Days');
    expect(dialog).toHaveTextContent(th.packageDialog.contactTeam);
    expect(within(dialog).getByRole('button', { name: th.packageDialog.pay })).toBeDisabled();
  });

  it.each([
    [ErrorCode.EMAIL_UNAVAILABLE, 409],
    [ErrorCode.PACKAGE_UNAVAILABLE, 404],
    [ErrorCode.VALIDATION_FAILED, 400],
  ] as const)('shows %s in Thai', async (code, status) => {
    stubFetch(() => apiError(status, code));
    renderIntl(<PackageCards data={response()} signedIn={false} />);
    const dialog = await choose('3 Days');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.name), 'Somchai');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.email), 'a@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(th.errors.codes[code]);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('coupon in the paid dialog (ADR 0030)', () => {
  const priced = (percentOff: number, priceSatang: number) => ({
    couponCode: 'TEST99',
    percentOff,
    listTotalSatang: 42_693,
    price: packageTotal(priceSatang, VAT),
  });

  it('prices the code, shows the discount and sends it with the order', async () => {
    const sent = stubFetch((call) =>
      call.path === PACKAGE_ORDER_PATHS.coupon
        ? json(200, priced(99, 399))
        : json(200, { redirectUrl: 'https://snap.example/checkout/pay?order=x' }),
    );
    renderIntl(<PackageCards data={response()} signedIn />);
    const dialog = await choose('3 Days');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.coupon), 'test99');
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.couponApply }),
    );
    expect(await within(dialog).findByText('ใช้โค้ด TEST99 ลด 99%')).toBeInTheDocument();
    const summary = dialog.querySelector('dl');
    expect(summary).toHaveTextContent('ส่วนลด 99%−฿395.01');
    expect(summary).toHaveTextContent('ยอดชำระ฿426.93฿4.27');
    expect(sent[0]).toMatchObject({
      path: PACKAGE_ORDER_PATHS.coupon,
      body: { packageCode: 'd3', couponCode: 'TEST99' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sent[1]).toMatchObject({
      path: PACKAGE_ORDER_PATHS.order,
      body: { packageCode: 'd3', couponCode: 'TEST99' },
    });
  });

  it('a typed code is priced before paying; a refused one says why and sends no order', async () => {
    const sent = stubFetch(() => apiError(409, ErrorCode.COUPON_USED_UP));
    renderIntl(<PackageCards data={response()} signedIn />);
    const dialog = await choose('3 Days');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.coupon), 'GONE-1');
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    expect(await within(dialog).findByText(th.errors.codes.COUPON_USED_UP)).toBeInTheDocument();
    expect(sent.map((c) => c.path)).toEqual([PACKAGE_ORDER_PATHS.coupon]);
  });

  it('says "get the package" for 100% off', async () => {
    stubFetch(() => json(200, priced(100, 0)));
    renderIntl(<PackageCards data={response()} signedIn />);
    const dialog = await choose('3 Days');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.coupon), 'FREE100');
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.couponApply }),
    );
    expect(
      await within(dialog).findByRole('button', { name: th.packageDialog.getFree }),
    ).toBeInTheDocument();
  });
});

describe('Free sign-up with Turnstile (CAPTCHA_PROVIDER=turnstile)', () => {
  const TURNSTILE = {
    provider: 'turnstile',
    siteKey: '0x4AAAAAAAsite',
    scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
  } as const;
  const challenge = (rejected: 'expired' | 'invalid' | null) =>
    json(429, {
      code: ErrorCode.RATE_LIMITED,
      message: ErrorCode.RATE_LIMITED,
      details: {
        retryAfterSeconds: 0,
        captcha: { provider: 'turnstile', action: 'signup_free', rejected },
      },
    });

  async function fillFree() {
    const dialog = await choose('Free');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.name), 'Somchai');
    await userEvent.type(within(dialog).getByLabelText(th.packageDialog.email), 'a@example.com');
    await userEvent.click(
      within(dialog).getByRole('button', { name: th.packageDialog.freeSubmit }),
    );
    return dialog;
  }

  it('shows the challenge when the API asks, then resends with the token', async () => {
    const turnstile = new FakeTurnstile();
    const sent = stubFetch((call) =>
      (call.body as { captchaToken?: string }).captchaToken === undefined
        ? challenge(null)
        : new Response(null, { status: 204 }),
    );
    renderIntl(
      <PackageCards
        data={response()}
        signedIn={false}
        captcha={TURNSTILE}
        loadTurnstile={turnstile.loader}
      />,
    );
    const dialog = await fillFree();
    expect(await within(dialog).findByText(th.packageDialog.captchaRequired)).toBeInTheDocument();
    await waitFor(() => expect(turnstile.live()).toHaveLength(1));
    expect(turnstile.widgets[0]?.options.action).toBe('signup_free');
    expect(turnstile.widgets[0]?.options.sitekey).toBe(TURNSTILE.siteKey);
    turnstile.solve('turnstile-token-1');
    expect(await screen.findByText(th.packageDialog.freeSentTitle)).toBeInTheDocument();
    expect(sent.map((c) => c.body)).toEqual([
      { name: 'Somchai', email: 'a@example.com' },
      { name: 'Somchai', email: 'a@example.com', captchaToken: 'turnstile-token-1' },
    ]);
  });

  it('a refused token gets a fresh widget and says why', async () => {
    const turnstile = new FakeTurnstile();
    let answers = [challenge(null), challenge('expired'), new Response(null, { status: 204 })];
    const sent = stubFetch(() => {
      const [next, ...rest] = answers;
      answers = rest;
      return next as Response;
    });
    renderIntl(
      <PackageCards
        data={response()}
        signedIn={false}
        captcha={TURNSTILE}
        loadTurnstile={turnstile.loader}
      />,
    );
    const dialog = await fillFree();
    await waitFor(() => expect(turnstile.live()).toHaveLength(1));
    turnstile.solve('old-token');
    expect(await within(dialog).findByText(th.errors.details.captchaExpired)).toBeInTheDocument();
    await waitFor(() => expect(turnstile.widgets).toHaveLength(2));
    turnstile.solve('new-token');
    expect(await screen.findByText(th.packageDialog.freeSentTitle)).toBeInTheDocument();
    expect(sent.map((c) => (c.body as { captchaToken?: string }).captchaToken)).toEqual([
      undefined,
      'old-token',
      'new-token',
    ]);
  });

  it('without Turnstile on this site, a challenge reads as "wait"', async () => {
    stubFetch(() => challenge(null));
    renderIntl(<PackageCards data={response()} signedIn={false} />);
    const dialog = await fillFree();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'ส่งคำขอบ่อยเกินไป กรุณารออีก 1 นาทีแล้วลองใหม่',
    );
  });
});
