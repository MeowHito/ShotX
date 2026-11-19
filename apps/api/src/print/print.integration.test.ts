import { files, printOrders } from '@shotx/db';
import {
  apiPath,
  createPrintOrderResponseSchema,
  listPrintOrdersResponseSchema,
  ownerPrintOrderSchema,
  PRINT_ROUTES as R,
  printSettingsSchema,
  sharePrintsResponseSchema,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';

const prints = (token: string) => apiPath(R.shareStatus, { token });
const settingsPath = apiPath(R.getSettings);
const ordersPath = apiPath(R.listOrders);
const approve = (id: string) => apiPath(R.approveOrder, { id });
const reject = (id: string) => apiPath(R.rejectOrder, { id });
const print = (id: string) => apiPath(R.printOrder, { id });

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`print orders on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, { env: { PRINT_ORDER_RATE_PER_VIEWER: '50' } });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    async function event(
      settings: Partial<{
        enabled: boolean;
        approval: 'auto' | 'manual';
        perDeviceLimit: number;
        paperSizes: string[];
      }> = {},
      shareOptions: Parameters<TestApi['share']>[2] = {},
    ) {
      const owner = await api.photographer();
      const root = await api.folder(owner.id, { name: 'งานวิ่ง' });
      const list = [];
      for (let i = 0; i < 3; i++) list.push(await api.file(owner.id, root.id, `ภาพ ${i}.jpg`));
      const share = await api.share(owner.id, { folderId: root.id }, shareOptions);
      const res = await api.request('PUT', settingsPath, {
        token: owner.token,
        body: {
          enabled: true,
          approval: 'manual',
          perDeviceLimit: 2,
          paperSizes: ['4r', 'a4'],
          ...settings,
        },
      });
      expect(res.status).toBe(200);
      return { owner, root, files: list, share };
    }

    it('is off until the photographer switches it on', async () => {
      const owner = await api.photographer();
      const root = await api.folder(owner.id, { name: 'e' });
      const f = await api.file(owner.id, root.id);
      const share = await api.share(owner.id, { folderId: root.id });
      const got = await api.request('GET', settingsPath, { token: owner.token });
      expect(printSettingsSchema.parse(got.body)).toEqual({
        enabled: false,
        approval: 'manual',
        perDeviceLimit: 1,
        paperSizes: ['4r'],
      });
      const b = api.browser();
      const status = sharePrintsResponseSchema.parse(
        (await b.request('GET', prints(share.token))).body,
      );
      expect(status).toEqual({ offer: null, used: 0, orders: [] });
      const res = await b.request('POST', prints(share.token), {
        body: { fileId: f.id, paperSize: '4r' },
      });
      expect(res).toMatchObject({ status: 404, body: { code: 'PRINT_UNAVAILABLE' } });
    });

    it('takes orders per device up to the limit; manual orders wait for approval', async () => {
      const { owner, share, files: list } = await event();
      const phone = api.browser();
      const first = await phone.request('POST', prints(share.token), {
        body: { fileId: list[0]?.id, paperSize: '4r', customerName: '  บิบ 42 ' },
      });
      expect(first.status).toBe(201);
      const created = createPrintOrderResponseSchema.parse(first.body);
      expect(created).toMatchObject({
        used: 1,
        perDeviceLimit: 2,
        order: { orderNumber: 1, status: 'pending', paperSize: '4r' },
      });
      await phone.request('POST', prints(share.token), {
        body: { fileId: list[1]?.id, paperSize: 'a4' },
      });
      const third = await phone.request('POST', prints(share.token), {
        body: { fileId: list[2]?.id, paperSize: 'a4' },
      });
      expect(third).toMatchObject({
        status: 409,
        body: { code: 'PRINT_LIMIT_REACHED', details: { limit: 2, used: 2 } },
      });
      // Another device has its own limit; numbers go on per photographer.
      const other = await api.browser().request('POST', prints(share.token), {
        body: { fileId: list[2]?.id, paperSize: '4r' },
      });
      expect(createPrintOrderResponseSchema.parse(other.body).order.orderNumber).toBe(3);

      const status = sharePrintsResponseSchema.parse(
        (await phone.request('GET', prints(share.token))).body,
      );
      expect(status.offer).toEqual({
        paperSizes: ['4r', 'a4'],
        perDeviceLimit: 2,
        approval: 'manual',
      });
      expect(status.used).toBe(2);
      expect(status.orders.map((o) => o.orderNumber)).toEqual([2, 1]);

      const listed = listPrintOrdersResponseSchema.parse(
        (await api.request('GET', `${ordersPath}?status=pending`, { token: owner.token })).body,
      );
      expect(listed.counts).toEqual({ pending: 3, queued: 0, printed: 0, rejected: 0 });
      const mine = listed.items.find((o) => o.orderNumber === 1);
      expect(mine).toMatchObject({
        customerName: 'บิบ 42',
        eventName: 'งานวิ่ง',
        fileName: 'ภาพ 0.jpg',
        printCount: 0,
      });
      expect(mine?.deviceLabel).toMatch(/^[0-9A-F]{4}$/);
      expect(new URL(mine?.printUrl ?? '').pathname).toContain('/media/originals/');

      // A rejected order gives the device its print back.
      const rejected = await api.request('POST', reject(created.order.id), { token: owner.token });
      expect(ownerPrintOrderSchema.parse(rejected.body).status).toBe('rejected');
      const again = await phone.request('POST', prints(share.token), {
        body: { fileId: list[2]?.id, paperSize: '4r' },
      });
      expect(again.status).toBe(201);
    });

    it('queues auto orders; a station takes each queued order once', async () => {
      const { owner, share, files: list } = await event({ approval: 'auto', perDeviceLimit: 5 });
      const res = await api.browser().request('POST', prints(share.token), {
        body: { fileId: list[0]?.id, paperSize: 'a4' },
      });
      const { order } = createPrintOrderResponseSchema.parse(res.body);
      expect(order.status).toBe('queued');
      const station = await api.request('POST', print(order.id), {
        token: owner.token,
        body: { onlyQueued: true },
      });
      expect(ownerPrintOrderSchema.parse(station.body)).toMatchObject({
        status: 'printed',
        printCount: 1,
      });
      // A second station finds it taken.
      const second = await api.request('POST', print(order.id), {
        token: owner.token,
        body: { onlyQueued: true },
      });
      expect(second).toMatchObject({ status: 409, body: { code: 'CONFLICT' } });
      // The photographer's own button prints it again.
      const reprint = await api.request('POST', print(order.id), { token: owner.token, body: {} });
      expect(ownerPrintOrderSchema.parse(reprint.body).printCount).toBe(2);
      // Printed orders can't be rejected or approved.
      expect((await api.request('POST', reject(order.id), { token: owner.token })).status).toBe(
        409,
      );
      expect((await api.request('POST', approve(order.id), { token: owner.token })).status).toBe(
        409,
      );
    });

    it('approves pending orders into the queue', async () => {
      const { owner, share, files: list } = await event();
      const res = await api.browser().request('POST', prints(share.token), {
        body: { fileId: list[0]?.id, paperSize: '4r' },
      });
      const { order } = createPrintOrderResponseSchema.parse(res.body);
      // A station never takes a pending order.
      expect(
        (
          await api.request('POST', print(order.id), {
            token: owner.token,
            body: { onlyQueued: true },
          })
        ).status,
      ).toBe(409);
      const approved = await api.request('POST', approve(order.id), { token: owner.token });
      expect(ownerPrintOrderSchema.parse(approved.body)).toMatchObject({ status: 'queued' });
      expect(ownerPrintOrderSchema.parse(approved.body).decidedAt).not.toBeNull();
    });

    it('refuses sizes not offered, videos, files outside the share and other owners', async () => {
      const { owner, share, files: list } = await event({ paperSizes: ['5r'] });
      const b = api.browser();
      expect(
        await b.request('POST', prints(share.token), {
          body: { fileId: list[0]?.id, paperSize: 'a4' },
        }),
      ).toMatchObject({ status: 422, body: { code: 'PRINT_SIZE_UNAVAILABLE' } });

      await api.db
        .update(files)
        .set({ mime: 'video/mp4' })
        .where(eq(files.id, list[1]?.id ?? ''));
      expect(
        await b.request('POST', prints(share.token), {
          body: { fileId: list[1]?.id, paperSize: '5r' },
        }),
      ).toMatchObject({ status: 404, body: { code: 'PRINT_UNAVAILABLE' } });

      const loose = await api.file(owner.id, null);
      const foreign = await api.file((await api.photographer()).id, null);
      for (const id of [loose.id, foreign.id]) {
        const res = await b.request('POST', prints(share.token), {
          body: { fileId: id, paperSize: '5r' },
        });
        expect(res).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
      }

      // Another photographer can't see, approve or print the order.
      const ok = await b.request('POST', prints(share.token), {
        body: { fileId: list[0]?.id, paperSize: '5r' },
      });
      const { order } = createPrintOrderResponseSchema.parse(ok.body);
      const stranger = await api.photographer();
      expect((await api.request('POST', approve(order.id), { token: stranger.token })).status).toBe(
        404,
      );
      const strangerList = listPrintOrdersResponseSchema.parse(
        (await api.request('GET', ordersPath, { token: stranger.token })).body,
      );
      expect(strangerList.items).toEqual([]);
    });

    it('needs the face_only grant, and keeps no order once the file is purged', async () => {
      const { share, files: list } = await event({}, { mode: 'face_only' });
      const res = await api.browser().request('POST', prints(share.token), {
        body: { fileId: list[0]?.id, paperSize: '4r' },
      });
      expect(res).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });

      const open = await event();
      const placed = await api.browser().request('POST', prints(open.share.token), {
        body: { fileId: open.files[0]?.id, paperSize: '4r' },
      });
      const { order } = createPrintOrderResponseSchema.parse(placed.body);
      // Trashed: listed without URLs, and can't be printed.
      await api.trashFile(open.files[0]?.id ?? '');
      const listed = listPrintOrdersResponseSchema.parse(
        (await api.request('GET', ordersPath, { token: open.owner.token })).body,
      );
      expect(listed.items[0]).toMatchObject({ id: order.id, printUrl: null, thumbUrl: null });
      expect(
        (await api.request('POST', print(order.id), { token: open.owner.token, body: {} })).status,
      ).toBe(409);
      // Purged: the order goes with the file.
      await api.db.delete(files).where(eq(files.id, open.files[0]?.id ?? ''));
      expect(await api.db.select().from(printOrders).where(eq(printOrders.id, order.id))).toEqual(
        [],
      );
    });
  });
}
