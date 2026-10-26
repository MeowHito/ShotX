import 'server-only';
import { BILLING_ROUTES, type PlansResponse } from '@shotx/shared';
import { createApiClient } from '../api/client';
import { type ServerCallContext, serverCallHeaders } from '../bff/client-ip';

/**
 * The public price list for SSR (`/pricing`), from the API's internal URL. Null when the API
 * fails: the page then says so instead of showing made-up prices.
 */
export async function fetchPlans(options: {
  apiInternalUrl: string;
  /** The BFF key and the viewer's address. */
  context?: ServerCallContext;
  fetch?: typeof fetch;
}): Promise<PlansResponse | null> {
  const api = createApiClient({
    baseUrl: `${options.apiInternalUrl.replace(/\/+$/, '')}/api`,
    fetch: options.fetch,
    headers: options.context !== undefined ? serverCallHeaders(options.context) : {},
  });
  try {
    return await api.call(BILLING_ROUTES.plans);
  } catch {
    return null;
  }
}
