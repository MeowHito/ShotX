import { handleStartPayment } from '@/lib/packages/orders';
import { packageOrderDeps } from '@/lib/server/packages';

/** ADR 0029: one payment attempt from the pay page (a PromptPay QR or a card form). */
export function POST(request: Request) {
  return handleStartPayment(request, packageOrderDeps(request.headers));
}
