// @vitest-environment node
import {
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  ORDER_TOKEN_HEADER,
  PACKAGE_ORDER_COOKIE,
  PACKAGE_ORDER_COOKIE_MAX_AGE_SECONDS,
  PACKAGE_ROUTES,
  parsePackageOrderCookie,
} from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { BFF_KEY, FakeAuthApi } from '../../../test/fake-auth-api';
import type { AuthDeps } from '../auth/handlers';
import { cookieNames, decodeSession, encodeJsonCookie } from '../auth/session';
import { createShotxAuthProvider, RefreshCache } from '../auth/shotx';
import { handleFreeSignupConfirm, handleFreeSignupRequest } from '../auth/signup';
import {
  handleCreateOrder,
  handleFakeResult,
  handleOrderStatus,
  handleStartPayment,
  type PackageOrderDeps,
} from './orders';

// ADR 0026: web's own routes for Free sign-up and package orders, against the fake API.

const BASE = 'https://photos.example.com';
const names = cookieNames(true);
const IP = '203.0.113.7';

function setup() {
  const api = new FakeAuthApi();
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) =>
    api.fetch((input as string).replace('http://api:4000', 'http://api'), init),
  );
  const provider = createShotxAuthProvider({
    apiInternalUrl: 'http://api:4000',
    client: { refreshReuseGraceSeconds: 10, callTimeoutMs: 15_000 },
    context: { bffKey: BFF_KEY, clientIp: IP },
    fetch,
    devLogin: false,
    refreshCache: new RefreshCache(0, () => api.now),
  });
  const auth: AuthDeps = { provider, publicBaseUrl: BASE, secureCookies: true, now: () => api.now };
  const deps: PackageOrderDeps = {
    auth,
    apiInternalUrl: 'http://api:4000',
    context: { bffKey: BFF_KEY, clientIp: IP },
    timeoutMs: 15_000,
    fetch,
  };
  return { api, auth, deps };
}

/** Set-Cookie headers of a response as name -> { value, raw }. */
function cookiesOf(response: Response): Map<string, { value: string; raw: string }> {
  return new Map(
    response.headers.getSetCookie().map((raw) => {
      const [pair = ''] = raw.split(';');
      const eq = pair.indexOf('=');
      return [pair.slice(0, eq), { value: decodeURIComponent(pair.slice(eq + 1)), raw }];
    }),
  );
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const KEY = crypto.randomUUID();

/** A signed-in photographer's session cookies. */
function signedInCookie(api: FakeAuthApi) {
  const account = api.addPhotographer({
    email: 'somchai@example.com',
    password: 'my-own-Secret-77',
    mustChange: false,
  });
  const tokens = api.signIn(account.subject, { email: account.email, name: account.name });
  const session = encodeJsonCookie({
    accessToken: tokens.accessToken,
    expiresAt: api.now + tokens.expiresIn * 1000,
    user: { sub: account.subject, email: account.email, name: account.name },
  });
  return { tokens, cookie: `${names.session}=${session}; ${names.refresh}=${tokens.refreshToken}` };
}

describe('POST /checkout/order', () => {
  it('creates the order with web key and IP, keeps the token in an httpOnly cookie only', async () => {
    const { api, deps } = setup();
    const response = await handleCreateOrder(
      post(
        '/checkout/order',
        { packageCode: 'd7', name: 'Somchai', email: 'somchai@example.com' },
        { [IDEMPOTENCY_KEY_HEADER]: KEY },
      ),
      deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const [orderId, order] = [...api.orders][0] ?? [];
    expect(body).toEqual({ redirectUrl: `${BASE}/checkout/fake?order=${orderId}` });
    expect(JSON.stringify(body)).not.toContain(order?.token);

    const cookie = cookiesOf(response).get(PACKAGE_ORDER_COOKIE);
    expect(parsePackageOrderCookie(cookie?.value)).toEqual({ orderId, accessToken: order?.token });
    expect(cookie?.raw).toContain('HttpOnly');
    expect(cookie?.raw).toContain('Secure');
    expect(cookie?.raw).toContain('SameSite=Lax');
    expect(cookie?.raw).toContain(`Max-Age=${PACKAGE_ORDER_COOKIE_MAX_AGE_SECONDS}`);
    // Sent only to the checkout routes and pages, never to the rest of the site.
    expect(cookie?.raw).toContain('Path=/checkout;');

    const call = api.calls.find((c) => c.route === PACKAGE_ROUTES.createOrder);
    expect(call?.headers[BFF_KEY_HEADER]).toBe(BFF_KEY);
    expect(call?.headers[BFF_CLIENT_IP_HEADER]).toBe(IP);
    expect(call?.headers[IDEMPOTENCY_KEY_HEADER]).toBe(KEY);
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.body).toEqual({
      packageCode: 'd7',
      name: 'Somchai',
      email: 'somchai@example.com',
    });
  });

  it("forwards a signed-in photographer's token and drops name and email", async () => {
    const { api, deps } = setup();
    const { tokens, cookie } = signedInCookie(api);
    const response = await handleCreateOrder(
      post(
        '/checkout/order',
        { packageCode: 'd15', name: 'Someone', email: 'other@example.com' },
        { [IDEMPOTENCY_KEY_HEADER]: KEY, cookie },
      ),
      deps,
    );
    expect(response.status).toBe(200);
    const call = api.calls.find((c) => c.route === PACKAGE_ROUTES.createOrder);
    expect(call?.headers.authorization).toBe(`Bearer ${tokens.accessToken}`);
    expect(call?.body).toEqual({ packageCode: 'd15' });
    expect([...api.orders.values()][0]?.view.emailMasked).toBe('s***@example.com');
  });

  it('without a session, name and email are required (UNAUTHENTICATED: the dialog asks them)', async () => {
    const { api, deps } = setup();
    const response = await handleCreateOrder(
      post('/checkout/order', { packageCode: 'd7' }, { [IDEMPOTENCY_KEY_HEADER]: KEY }),
      deps,
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(api.calls).toEqual([]);
  });

  it('refuses a missing Idempotency-Key, a cross-site request, and passes API refusals on', async () => {
    const { api, deps } = setup();
    const body = { packageCode: 'd7', name: 'S', email: 's@example.com' };
    expect((await handleCreateOrder(post('/checkout/order', body), deps)).status).toBe(400);
    expect(
      (
        await handleCreateOrder(
          post('/checkout/order', body, {
            [IDEMPOTENCY_KEY_HEADER]: KEY,
            origin: 'https://evil.example',
          }),
          deps,
        )
      ).status,
    ).toBe(403);
    api.packageGateway = 'off';
    const off = await handleCreateOrder(
      post('/checkout/order', body, { [IDEMPOTENCY_KEY_HEADER]: KEY }),
      deps,
    );
    expect(off.status).toBe(409);
    expect(((await off.json()) as { code: string }).code).toBe(ErrorCode.PAYMENT_UNAVAILABLE);
    expect(cookiesOf(off).has(PACKAGE_ORDER_COOKIE)).toBe(false);
  });
});

describe('GET /checkout/order and the test gateway', () => {
  async function ordered() {
    const ctx = setup();
    const created = await handleCreateOrder(
      post(
        '/checkout/order',
        { packageCode: 'd7', name: 'Somchai', email: 'somchai@example.com' },
        { [IDEMPOTENCY_KEY_HEADER]: KEY },
      ),
      ctx.deps,
    );
    const value = cookiesOf(created).get(PACKAGE_ORDER_COOKIE)?.value ?? '';
    const parsed = parsePackageOrderCookie(value);
    if (parsed === null) throw new Error('no order cookie');
    return { ...ctx, cookie: `${PACKAGE_ORDER_COOKIE}=${value}`, ...parsed };
  }

  it('reads the order with the token from the cookie (X-Order-Token)', async () => {
    const { api, deps, cookie, accessToken } = await ordered();
    const response = await handleOrderStatus(
      new Request(`${BASE}/checkout/order`, { headers: { cookie } }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'pending',
      emailMasked: 's***@example.com',
    });
    const call = api.calls.find((c) => c.route === PACKAGE_ROUTES.getOrder);
    expect(call?.headers[ORDER_TOKEN_HEADER]).toBe(accessToken);
    expect(call?.headers[BFF_KEY_HEADER]).toBe(BFF_KEY);
  });

  it('no cookie: ORDER_NOT_FOUND without asking the API; a stale one is cleared', async () => {
    const { api, deps, orderId } = await ordered();
    const none = await handleOrderStatus(new Request(`${BASE}/checkout/order`), deps);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { code: string }).code).toBe(ErrorCode.ORDER_NOT_FOUND);
    expect(api.calls.filter((c) => c.route === PACKAGE_ROUTES.getOrder)).toEqual([]);

    const stale = await handleOrderStatus(
      new Request(`${BASE}/checkout/order`, {
        headers: { cookie: `${PACKAGE_ORDER_COOKIE}=${orderId}.${'z'.repeat(43)}` },
      }),
      deps,
    );
    expect(stale.status).toBe(404);
    // Cleared with the Path it was set with, or the browser would keep the old one.
    expect(cookiesOf(stale).get(PACKAGE_ORDER_COOKIE)?.raw).toContain('Max-Age=0');
    expect(cookiesOf(stale).get(PACKAGE_ORDER_COOKIE)?.raw).toContain('Path=/checkout;');
  });

  it("the fake result applies only to the order in this browser's cookie", async () => {
    const { deps, cookie, orderId } = await ordered();
    const other = await handleFakeResult(
      post(
        '/checkout/order/fake-result',
        { orderId: crypto.randomUUID(), result: 'paid' },
        { cookie },
      ),
      deps,
    );
    expect(other.status).toBe(404);
    const paid = await handleFakeResult(
      post('/checkout/order/fake-result', { orderId, result: 'paid' }, { cookie }),
      deps,
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ status: 'paid', accountCreated: true });
  });

  it("without the fake gateway the API's NOT_FOUND comes through", async () => {
    const { api, deps, cookie, orderId } = await ordered();
    api.packageGateway = 'mpay';
    const response = await handleFakeResult(
      post('/checkout/order/fake-result', { orderId, result: 'paid' }, { cookie }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('mPAY pay page routes (ADR 0029)', () => {
  it("starts a payment only for the order in this browser's cookie, same-origin only", async () => {
    const ctx = setup();
    ctx.api.packageGateway = 'mpay';
    const created = await handleCreateOrder(
      post(
        '/checkout/order',
        { packageCode: 'd3', name: 'Somchai', email: 'somchai@example.com' },
        { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
      ),
      ctx.deps,
    );
    const value = cookiesOf(created).get(PACKAGE_ORDER_COOKIE)?.value ?? '';
    const parsed = parsePackageOrderCookie(value);
    if (parsed === null) throw new Error('no order cookie');
    const cookie = `${PACKAGE_ORDER_COOKIE}=${value}`;

    const qr = await handleStartPayment(
      post('/checkout/order/pay', { orderId: parsed.orderId, method: 'qr' }, { cookie }),
      ctx.deps,
    );
    expect(qr.status).toBe(200);
    expect(await qr.json()).toMatchObject({ method: 'qr' });
    const call = ctx.api.calls.find((c) => c.route === PACKAGE_ROUTES.pay);
    expect(call?.headers[ORDER_TOKEN_HEADER]).toBe(parsed.accessToken);

    const card = await handleStartPayment(
      post('/checkout/order/pay', { orderId: parsed.orderId, method: 'card' }, { cookie }),
      ctx.deps,
    );
    expect(await card.json()).toEqual({
      method: 'card',
      redirectUrl: 'https://pay.mpay.example.test/form/1',
    });

    const other = await handleStartPayment(
      post('/checkout/order/pay', { orderId: crypto.randomUUID(), method: 'qr' }, { cookie }),
      ctx.deps,
    );
    expect(other.status).toBe(404);
    const bad = await handleStartPayment(
      post('/checkout/order/pay', { orderId: parsed.orderId, method: 'cash' }, { cookie }),
      ctx.deps,
    );
    expect(bad.status).toBe(400);
    const cross = await handleStartPayment(
      post(
        '/checkout/order/pay',
        { orderId: parsed.orderId, method: 'qr' },
        { cookie, origin: 'https://evil.example' },
      ),
      ctx.deps,
    );
    expect(cross.status).toBe(403);
  });
});

describe('Free sign-up routes', () => {
  it('step 1 answers 204 whether or not the email has an account', async () => {
    const { api, auth } = setup();
    api.addPhotographer({ email: 'taken@example.com', password: 'x-Secret-1234' });
    for (const email of ['new@example.com', 'taken@example.com']) {
      const response = await handleFreeSignupRequest(
        post('/auth/signup/free', { name: 'Somchai', email }),
        auth,
      );
      expect(response.status).toBe(204);
    }
    expect(api.signupRequests.map((r) => r.email)).toEqual([
      'new@example.com',
      'taken@example.com',
    ]);
    expect(api.calls.every((c) => c.headers[BFF_KEY_HEADER] === BFF_KEY)).toBe(true);
    // Sales off: the API's NOT_FOUND comes through.
    api.packageSales = false;
    const off = await handleFreeSignupRequest(
      post('/auth/signup/free', { name: 'S', email: 'x@example.com' }),
      auth,
    );
    expect(off.status).toBe(404);
  });

  it('passes the Turnstile token on', async () => {
    const { api, auth } = setup();
    const response = await handleFreeSignupRequest(
      post('/auth/signup/free', {
        name: 'Somchai',
        email: 'new@example.com',
        captchaToken: 'turnstile-token-1',
      }),
      auth,
    );
    expect(response.status).toBe(204);
    expect(api.signupRequests).toEqual([
      { name: 'Somchai', email: 'new@example.com', captchaToken: 'turnstile-token-1' },
    ]);
    const call = api.calls.find((c) => c.route === PACKAGE_ROUTES.signupFree);
    expect(call?.body).toEqual({
      name: 'Somchai',
      email: 'new@example.com',
      captchaToken: 'turnstile-token-1',
    });
  });

  it('step 2 creates the account and stores the session like the password reset', async () => {
    const { api, auth } = setup();
    await handleFreeSignupRequest(
      post('/auth/signup/free', { name: 'Somchai', email: 'new@example.com' }),
      auth,
    );
    const [token] = [...api.signupLinks.keys()];
    const response = await handleFreeSignupConfirm(
      post('/auth/signup/confirm', { token, password: 'my-own-Secret-77' }),
      auth,
    );
    expect(response.status).toBe(204);
    const cookies = cookiesOf(response);
    expect(decodeSession(cookies.get(names.session)?.value)?.user.email).toBe('new@example.com');
    expect(cookies.get(names.refresh)?.raw).toContain('HttpOnly');

    // Single use.
    const again = await handleFreeSignupConfirm(
      post('/auth/signup/confirm', { token, password: 'my-own-Secret-77' }),
      auth,
    );
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe(ErrorCode.SIGNUP_LINK_INVALID);
    expect(cookiesOf(again).size).toBe(0);
  });

  it('refuses a malformed token or a cross-site request without calling the API', async () => {
    const { api, auth } = setup();
    expect(
      (
        await handleFreeSignupConfirm(
          post('/auth/signup/confirm', { token: 'short', password: 'my-own-Secret-77' }),
          auth,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleFreeSignupRequest(
          post(
            '/auth/signup/free',
            { name: 'S', email: 's@example.com' },
            { origin: 'https://evil.example' },
          ),
          auth,
        )
      ).status,
    ).toBe(403);
    expect(api.calls).toEqual([]);
  });
});
