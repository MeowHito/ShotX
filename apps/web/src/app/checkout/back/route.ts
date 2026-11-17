import { PACKAGE_CHECKOUT_RETURN_PATH } from '@shotx/shared';
import { packageOrderDeps } from '@/lib/server/packages';

/**
 * ADR 0029 (PACKAGE_GATEWAY_RETURN_PATH): mPAY's card form sends the buyer back here, with a GET
 * or a POST. Nothing in the request is read: 303 to the return page, which asks the API (the
 * signed Payment Notify or mPAY's own enquiry decide).
 */
function back(request: Request): Response {
  const target = new URL(
    PACKAGE_CHECKOUT_RETURN_PATH,
    packageOrderDeps(request.headers).auth.publicBaseUrl,
  );
  return new Response(null, {
    status: 303,
    headers: { location: target.toString(), 'cache-control': 'no-store' },
  });
}

export function GET(request: Request) {
  return back(request);
}

export function POST(request: Request) {
  return back(request);
}
