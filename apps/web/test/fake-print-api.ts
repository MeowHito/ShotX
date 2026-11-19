import {
  type OwnerPrintOrder,
  PRINT_ORDER_STATUSES,
  PRINT_ROUTES,
  PRINT_SETTINGS_DEFAULTS,
  type PrintOrderStatus,
  type PrintPaperSize,
  type PrintSettings,
  type RouteContract,
} from '@shotx/shared';
import { type FakeApi, Fail, MEDIA, NOW } from './fake-api';
import { gate, NOT_HANDLED, publicShareOrFail, visibleItems } from './fake-share-api';

/** Print orders of the fake API (ADR 0031): one photographer's settings and every order. */
export class FakePrints {
  settings: PrintSettings = { ...PRINT_SETTINGS_DEFAULTS };
  orders: (OwnerPrintOrder & { token: string })[] = [];
  /** Device of the fake browser: every public call comes from it. */
  device = 'A1B2';

  /** Seeds an order (as if a viewer placed it). */
  add(order: Partial<OwnerPrintOrder> & { token?: string } = {}): OwnerPrintOrder {
    const n = this.orders.length + 1;
    const fileId = order.fileId ?? crypto.randomUUID();
    const row = {
      id: crypto.randomUUID(),
      orderNumber: n,
      status: 'pending' as PrintOrderStatus,
      paperSize: '4r' as PrintPaperSize,
      customerName: null,
      deviceLabel: this.device,
      shareId: crypto.randomUUID(),
      eventName: 'งานวิ่ง',
      fileId,
      fileName: `IMG_${n}.jpg`,
      width: 4000,
      height: 6000,
      thumbUrl: `${MEDIA}/derived/p/${fileId}/thumb.webp?Signature=s`,
      printUrl: `${MEDIA}/originals/p/${fileId}/IMG_${n}.jpg?Signature=s`,
      printCount: 0,
      createdAt: new Date(Date.parse(NOW) + n * 1000).toISOString(),
      decidedAt: null,
      printedAt: null,
      token: '',
      ...order,
    };
    this.orders.unshift(row);
    return row;
  }
}

function owner({ token: _token, ...order }: OwnerPrintOrder & { token: string }): OwnerPrintOrder {
  return order;
}

export function handlePrint(
  api: FakeApi,
  route: RouteContract,
  params: Record<string, string>,
  query: unknown,
  body: unknown,
): unknown {
  const p = api.prints;
  switch (route) {
    case PRINT_ROUTES.shareStatus: {
      const share = publicShareOrFail(api, params.token);
      gate(api, share);
      const mine = p.orders.filter((o) => o.token === share.token);
      return {
        offer: p.settings.enabled
          ? {
              paperSizes: p.settings.paperSizes,
              perDeviceLimit: p.settings.perDeviceLimit,
              approval: p.settings.approval,
            }
          : null,
        used: mine.filter((o) => o.status !== 'rejected').length,
        orders: mine.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          fileId: o.fileId,
          paperSize: o.paperSize,
          status: o.status,
          createdAt: o.createdAt,
        })),
      };
    }
    case PRINT_ROUTES.createOrder: {
      const share = publicShareOrFail(api, params.token);
      gate(api, share);
      const b = body as { fileId: string; paperSize: PrintPaperSize; customerName: string | null };
      if (!p.settings.enabled) throw new Fail('PRINT_UNAVAILABLE');
      if (!p.settings.paperSizes.includes(b.paperSize)) throw new Fail('PRINT_SIZE_UNAVAILABLE');
      const item = visibleItems(share).find((i) => i.id === b.fileId);
      if (item === undefined) throw new Fail('NOT_FOUND');
      const used = p.orders.filter(
        (o) => o.token === share.token && o.status !== 'rejected',
      ).length;
      if (used >= p.settings.perDeviceLimit) {
        throw new Fail('PRINT_LIMIT_REACHED', { limit: p.settings.perDeviceLimit, used });
      }
      const order = p.add({
        token: share.token,
        fileId: item.id,
        fileName: item.name,
        paperSize: b.paperSize,
        customerName: b.customerName,
        status: p.settings.approval === 'auto' ? 'queued' : 'pending',
      });
      return {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          fileId: order.fileId,
          paperSize: order.paperSize,
          status: order.status,
          createdAt: order.createdAt,
        },
        used: used + 1,
        perDeviceLimit: p.settings.perDeviceLimit,
      };
    }
    case PRINT_ROUTES.getSettings:
      return p.settings;
    case PRINT_ROUTES.updateSettings:
      p.settings = body as PrintSettings;
      return p.settings;
    case PRINT_ROUTES.listOrders: {
      const status = (query as { status?: PrintOrderStatus }).status;
      const counts = Object.fromEntries(
        PRINT_ORDER_STATUSES.map((s) => [s, p.orders.filter((o) => o.status === s).length]),
      );
      return {
        items: p.orders.filter((o) => status === undefined || o.status === status).map(owner),
        counts,
      };
    }
    case PRINT_ROUTES.approveOrder:
    case PRINT_ROUTES.rejectOrder:
    case PRINT_ROUTES.printOrder: {
      const order = p.orders.find((o) => o.id === params.id);
      if (order === undefined) throw new Fail('NOT_FOUND');
      if (route === PRINT_ROUTES.approveOrder) {
        if (order.status !== 'pending') throw new Fail('CONFLICT');
        Object.assign(order, { status: 'queued', decidedAt: NOW });
      } else if (route === PRINT_ROUTES.rejectOrder) {
        if (order.status !== 'pending' && order.status !== 'queued') throw new Fail('CONFLICT');
        Object.assign(order, { status: 'rejected', decidedAt: NOW });
      } else {
        const onlyQueued = (body as { onlyQueued: boolean }).onlyQueued;
        if (order.status === 'rejected' || (onlyQueued && order.status !== 'queued')) {
          throw new Fail('CONFLICT');
        }
        Object.assign(order, {
          status: 'printed',
          printedAt: NOW,
          printCount: order.printCount + 1,
        });
      }
      return owner(order);
    }
    default:
      return NOT_HANDLED;
  }
}
