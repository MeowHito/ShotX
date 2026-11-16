import { handleFakeResult } from '@/lib/packages/orders';
import { packageOrderDeps } from '@/lib/server/packages';

/** ADR 0026: the test gateway's "paid" / "failed" buttons (the API answers only with the fake gateway). */
export function POST(request: Request) {
  return handleFakeResult(request, packageOrderDeps(request.headers));
}
