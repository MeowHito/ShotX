import 'server-only';
import { PACKAGE_ROUTES, type PackagesResponse } from '@shotx/shared';
import { createApiClient } from '../api/client';
import { type ServerCallContext, serverCallHeaders } from '../bff/client-ip';
import type { PackageOrderDeps } from '../packages/orders';
import { authDeps, serverCallContext } from './auth';
import { webConfig } from './config';

/**
 * The public package list for the home page's SSR (ADR 0026: GET /packages, prices and the sales
 * switches), from the API's internal URL. Null when the API fails: the page then says so instead
 * of showing made-up prices.
 */
export async function fetchPackages(options: {
  apiInternalUrl: string;
  /** The BFF key and the viewer's address. */
  context?: ServerCallContext;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<PackagesResponse | null> {
  const api = createApiClient({
    baseUrl: `${options.apiInternalUrl.replace(/\/+$/, '')}/api`,
    fetch: options.fetch,
    headers: options.context !== undefined ? serverCallHeaders(options.context) : {},
  });
  try {
    return await api.call(PACKAGE_ROUTES.list, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return null;
  }
}

/** Dependencies of the package-order route handlers, from the environment and the request. */
export function packageOrderDeps(requestHeaders: Headers): PackageOrderDeps {
  const config = webConfig();
  return {
    auth: authDeps(requestHeaders),
    apiInternalUrl: config.apiInternalUrl,
    context: serverCallContext(requestHeaders, config),
    timeoutMs: config.authClient.callTimeoutMs,
  };
}
