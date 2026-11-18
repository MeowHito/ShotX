import {
  checkPackageCouponBodySchema,
  createPackageOrderBodySchema,
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  idSchema,
  ORDER_TOKEN_HEADER,
  PACKAGE_ORDER_COOKIE,
  PACKAGE_ORDER_COOKIE_MAX_AGE_SECONDS,
  PACKAGE_ROUTES,
  packageOrderCookieValue,
  packageOrderFakeResultBodySchema,
  parsePackageOrderCookie,
  startPackagePaymentBodySchema,
} from '@shotx/shared';
import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { parseCookies, serializeCookie } from '../auth/cookies';
import { type AuthDeps, isSameOrigin, resolveSession } from '../auth/handlers';
import { errorResponse, readBody } from '../auth/password';
import { type ServerCallContext, serverCallHeaders } from '../bff/client-ip';
import { type CreateOrderResult, PACKAGE_ORDER_COOKIE_PATH } from './paths';

/**
 * Package orders through web (ADR 0026 section 4). The API's order routes are `bff` routes (web's
 * key only), and the order's access token must never reach browser JS, so web serves them itself:
 * - POST /checkout/order (PACKAGE_ORDER_PATHS.order) `{ packageCode, name?, email? }` with Idempotency-Key:
 *   PACKAGE_ROUTES.createOrder. A signed-in photographer's bearer token is forwarded (the order is
 *   for that account, so name and email are dropped); otherwise name and email are required. The
 *   answer's `orderId.accessToken` goes into the httpOnly PACKAGE_ORDER_COOKIE and the browser
 *   gets only `{ redirectUrl }`, the gateway's page to go to.
 * - GET /checkout/order (PACKAGE_ORDER_PATHS.order): PACKAGE_ROUTES.getOrder for the order in the cookie,
 *   with its token in ORDER_TOKEN_HEADER (no cookie: ORDER_NOT_FOUND).
 * - POST /checkout/order/pay `{ orderId, method }`: PACKAGE_ROUTES.pay (ADR 0029, the pay page's
 *   PromptPay QR or card form), for the order in the cookie only.
 * - POST /checkout/order/fake-result `{ orderId, result }`: the test gateway's buttons
 *   (PACKAGE_ROUTES.fakeResult; NOT_FOUND unless the API runs PACKAGE_GATEWAY=fake), for the
 *   order in the cookie only.
 * Errors are the API's `{ code, message, details }` with its status; POSTs are same-origin only.
 */

export interface PackageOrderDeps {
  /** The session cookies (a signed-in buyer), the site's origin and cookie security. */
  auth: AuthDeps;
  /** API origin (API_INTERNAL_URL); routes are under `/api` on it. */
  apiInternalUrl: string;
  /** The BFF key and the buyer's address. */
  context: ServerCallContext;
  /** How long one API call may take (AUTH_CLIENT_TIMEOUT_MS). */
  timeoutMs: number;
  fetch?: typeof fetch;
}

const createRequestSchema = createPackageOrderBodySchema;

const payRequestSchema = z.strictObject({
  orderId: idSchema,
  method: startPackagePaymentBodySchema.shape.method,
});

const fakeResultRequestSchema = z.strictObject({
  orderId: idSchema,
  result: packageOrderFakeResultBodySchema.shape.result,
});

function api(deps: PackageOrderDeps, accessToken?: string) {
  return createApiClient({
    baseUrl: `${deps.apiInternalUrl.replace(/\/+$/, '')}/api`,
    fetch: deps.fetch,
    headers: {
      ...serverCallHeaders(deps.context),
      ...(accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  });
}

function json(status: number, body: unknown, cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** The API's error as the browser gets it; no answer (or a malformed one) is a 502. */
function apiErrorResponse(error: unknown, cookies: readonly string[] = []): Response {
  if (error instanceof ApiError) {
    return errorResponse(error.status, error.code, error.details, cookies);
  }
  return errorResponse(502, ErrorCode.INTERNAL_ERROR, undefined, cookies);
}

function orderCookie(value: string, deps: PackageOrderDeps, maxAgeSeconds: number): string {
  // Lax: the gateway sends the buyer back with a top-level GET, which carries Lax cookies. Set
  // and cleared with the same Path, so the clearing cookie replaces the set one.
  return serializeCookie(PACKAGE_ORDER_COOKIE, value, {
    secure: deps.auth.secureCookies,
    maxAgeSeconds,
    sameSite: 'Lax',
    path: PACKAGE_ORDER_COOKIE_PATH,
  });
}

/** The order in this browser's PACKAGE_ORDER_COOKIE, or null. */
export function orderFromCookies(cookieHeader: string | null) {
  return parsePackageOrderCookie(parseCookies(cookieHeader).get(PACKAGE_ORDER_COOKIE));
}

/** POST /checkout/order. */
export async function handleCreateOrder(
  request: Request,
  deps: PackageOrderDeps,
): Promise<Response> {
  if (!isSameOrigin(request, deps.auth.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const key = idempotencyKeySchema.safeParse(request.headers.get(IDEMPOTENCY_KEY_HEADER));
  const parsed = createRequestSchema.safeParse(await readBody(request));
  if (!key.success || !parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);

  // A signed-in buyer buys for their own account (the API takes the email from the token).
  const { session, setCookies, unavailable } = await resolveSession(
    request.headers.get('cookie'),
    deps.auth,
  );
  if (unavailable === true) return errorResponse(502, ErrorCode.INTERNAL_ERROR);
  const { packageCode, name, email, couponCode } = parsed.data;
  if (session === null && (name === undefined || email === undefined)) {
    // The dialog asked for no name or email because the buyer looked signed in.
    return errorResponse(401, ErrorCode.UNAUTHENTICATED, undefined, setCookies);
  }
  const coupon = couponCode !== undefined ? { couponCode } : {};
  const body =
    session !== null ? { packageCode, ...coupon } : { packageCode, name, email, ...coupon };

  try {
    const order = await api(deps, session?.accessToken).call(PACKAGE_ROUTES.createOrder, {
      headers: { [IDEMPOTENCY_KEY_HEADER]: key.data },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const cookie = orderCookie(
      packageOrderCookieValue(order.orderId, order.accessToken),
      deps,
      PACKAGE_ORDER_COOKIE_MAX_AGE_SECONDS,
    );
    const result: CreateOrderResult = { redirectUrl: order.redirectUrl };
    return json(200, result, [...setCookies, cookie]);
  } catch (error) {
    return apiErrorResponse(error, setCookies);
  }
}

/** POST /checkout/coupon (ADR 0030): what a coupon makes a package cost, for the buy dialog. */
export async function handleCheckCoupon(
  request: Request,
  deps: PackageOrderDeps,
): Promise<Response> {
  if (!isSameOrigin(request, deps.auth.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const parsed = checkPackageCouponBodySchema.safeParse(await readBody(request));
  if (!parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);
  try {
    const result = await api(deps).call(PACKAGE_ROUTES.checkCoupon, {
      body: parsed.data,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    return json(200, result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** GET /checkout/order: the order of this browser, for /checkout/return. */
export async function handleOrderStatus(
  request: Request,
  deps: PackageOrderDeps,
): Promise<Response> {
  const order = orderFromCookies(request.headers.get('cookie'));
  if (order === null) return errorResponse(404, ErrorCode.ORDER_NOT_FOUND);
  try {
    const view = await api(deps).call(PACKAGE_ROUTES.getOrder, {
      params: { id: order.orderId },
      headers: { [ORDER_TOKEN_HEADER]: order.accessToken },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    return json(200, view);
  } catch (error) {
    // A cookie the API doesn't know (old, or a token replaced by a retried order) is dropped.
    const stale = error instanceof ApiError && error.code === ErrorCode.ORDER_NOT_FOUND;
    return apiErrorResponse(error, stale ? [orderCookie('', deps, 0)] : []);
  }
}

/** POST /checkout/order/fake-result: the test gateway's "paid" / "failed" buttons. */
export async function handleFakeResult(
  request: Request,
  deps: PackageOrderDeps,
): Promise<Response> {
  if (!isSameOrigin(request, deps.auth.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const parsed = fakeResultRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);
  const order = orderFromCookies(request.headers.get('cookie'));
  if (order === null || order.orderId !== parsed.data.orderId) {
    return errorResponse(404, ErrorCode.ORDER_NOT_FOUND);
  }
  try {
    const view = await api(deps).call(PACKAGE_ROUTES.fakeResult, {
      params: { id: order.orderId },
      headers: { [ORDER_TOKEN_HEADER]: order.accessToken },
      body: { result: parsed.data.result },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    return json(200, view);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** POST /checkout/order/pay: one payment attempt from the pay page (ADR 0029). */
export async function handleStartPayment(
  request: Request,
  deps: PackageOrderDeps,
): Promise<Response> {
  if (!isSameOrigin(request, deps.auth.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const parsed = payRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);
  const order = orderFromCookies(request.headers.get('cookie'));
  if (order === null || order.orderId !== parsed.data.orderId) {
    return errorResponse(404, ErrorCode.ORDER_NOT_FOUND);
  }
  try {
    const start = await api(deps).call(PACKAGE_ROUTES.pay, {
      params: { id: order.orderId },
      headers: { [ORDER_TOKEN_HEADER]: order.accessToken },
      body: { method: parsed.data.method },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    return json(200, start);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
