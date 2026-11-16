import { z } from 'zod';

/**
 * Web's own JSON routes for package orders (ADR 0026; src/lib/packages/orders). They sit beside
 * the gateway's return page (PACKAGE_CHECKOUT_RETURN_PATH) and the test gateway's page
 * (PACKAGE_FAKE_CHECKOUT_PATH). Free sign-up's routes are under /auth (AUTH_PATHS).
 */
export const PACKAGE_ORDER_PATHS = {
  /** POST: start an order (sets the order cookie). GET: the order in the cookie. */
  order: '/checkout/order',
  /** POST: the test gateway's result buttons. */
  fakeResult: '/checkout/order/fake-result',
} as const;

/**
 * The Path of PACKAGE_ORDER_COOKIE: every reader is under it (the routes above, the return page
 * and the test gateway's page), so the browser sends the order's token nowhere else on the site.
 */
export const PACKAGE_ORDER_COOKIE_PATH = '/checkout';

/** What POST {@link PACKAGE_ORDER_PATHS.order} answers the browser: where to pay. */
export const createOrderResultSchema = z.object({ redirectUrl: z.url({ protocol: /^https?$/ }) });
export type CreateOrderResult = z.output<typeof createOrderResultSchema>;
