import { handleCheckCoupon } from '@/lib/packages/orders';
import { packageOrderDeps } from '@/lib/server/packages';

/** ADR 0030: what a coupon makes a package cost, for the buy dialog. */
export function POST(request: Request) {
  return handleCheckCoupon(request, packageOrderDeps(request.headers));
}
