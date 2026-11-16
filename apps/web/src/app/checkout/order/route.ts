import { handleCreateOrder, handleOrderStatus } from '@/lib/packages/orders';
import { packageOrderDeps } from '@/lib/server/packages';

/** ADR 0026: start a package order (POST) and read the order of this browser (GET). */
export function POST(request: Request) {
  return handleCreateOrder(request, packageOrderDeps(request.headers));
}

export function GET(request: Request) {
  return handleOrderStatus(request, packageOrderDeps(request.headers));
}
