import {
  type CreatePackageOrderBody,
  IDEMPOTENCY_KEY_HEADER,
  type PackageOrderView,
  packageOrderViewSchema,
} from '@shotx/shared';
import type { z } from 'zod';
import { ContractError, errorFromResponse, NetworkError } from '../api/errors';
import { AUTH_PATHS } from '../auth/handlers';
import { type CreateOrderResult, createOrderResultSchema, PACKAGE_ORDER_PATHS } from './paths';

/**
 * Browser side of the Free sign-up and package-order routes web serves itself (ADR 0026;
 * src/lib/auth/signup, src/lib/packages/orders). Failures are thrown like the API client's
 * (ApiError with the API's code, NetworkError, ContractError), so the one error map words them.
 */

async function send(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
  fetchImpl: typeof fetch = (input, options) => fetch(input, options),
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : 'Network request failed');
  }
  if (!response.ok) throw errorFromResponse(response.status, await readJson(response));
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function parsed<S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S>> {
  const result = schema.safeParse(await readJson(response));
  if (!result.success) throw new ContractError(response.status, 'Unexpected response');
  return result.data;
}

/** Free sign-up step 1: resolves the same whether or not the email has an account. */
export async function requestFreeSignup(
  input: { name: string; email: string; captchaToken?: string },
  fetchImpl?: typeof fetch,
): Promise<void> {
  await send(AUTH_PATHS.signupFree, { method: 'POST', body: input }, fetchImpl);
}

/** Free sign-up step 2: creates the account; the response sets the session cookies. */
export async function confirmFreeSignup(
  input: { token: string; password: string },
  fetchImpl?: typeof fetch,
): Promise<void> {
  await send(AUTH_PATHS.signupConfirm, { method: 'POST', body: input }, fetchImpl);
}

/**
 * Starts a paid order (`idempotencyKey`: one per dialog, so a retried click is the same order).
 * The response sets the order cookie; the browser then goes to `redirectUrl`.
 */
export async function createPackageOrder(
  input: CreatePackageOrderBody,
  idempotencyKey: string,
  fetchImpl?: typeof fetch,
): Promise<CreateOrderResult> {
  const response = await send(
    PACKAGE_ORDER_PATHS.order,
    { method: 'POST', body: input, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } },
    fetchImpl,
  );
  return parsed(response, createOrderResultSchema);
}

/** The order of this browser (its cookie), for /checkout/return. */
export async function fetchPackageOrder(fetchImpl?: typeof fetch): Promise<PackageOrderView> {
  const response = await send(PACKAGE_ORDER_PATHS.order, { method: 'GET' }, fetchImpl);
  return parsed(response, packageOrderViewSchema);
}

/** The test gateway's result buttons (PACKAGE_GATEWAY=fake). */
export async function sendFakeResult(
  input: { orderId: string; result: 'paid' | 'failed' },
  fetchImpl?: typeof fetch,
): Promise<PackageOrderView> {
  const response = await send(
    PACKAGE_ORDER_PATHS.fakeResult,
    { method: 'POST', body: input },
    fetchImpl,
  );
  return parsed(response, packageOrderViewSchema);
}
