import { randomUUID } from 'node:crypto';
import {
  auditLog,
  cashPayments,
  dailyStats,
  expenses,
  packageOrders,
  packages,
  storageUsage,
  users,
} from '@shotx/db';
import {
  ADMIN_ROUTES as A,
  ADMIN_USER_FINANCE_MAX_ORDERS,
  adminUserFinanceResponseSchema,
  adminUserSchema,
  apiPath,
  AUTH_ROUTES as AR,
  authTokenResponseSchema,
  expenseSchema,
  financeResponseSchema,
  listAdminUsersResponseSchema,
  listAuditLogResponseSchema,
  listExpensesResponseSchema,
} from '@shotx/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, totpStep } from '../auth/totp';
import { challengeStep, createTotpAdmin } from '../testing/admins';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { FakeObjectStorage, OFFLINE_ACCOUNTS_ENV } from '../testing/fakes';
import { TestApi, type TestResponse } from '../testing/harness';
import { insertReadyFile } from '../testing/seed';
import { bffKeyFor, shotxEnv, TEST_ADMIN_BFF_KEY } from '../testing/shotx-auth';
import { nodeMetricsSource } from './server-metrics';
import { AdminSystemService } from './system.service';

// ADR 0027 end to end: the audit-log viewer, the expenses ledger, the finance summary and the
// per-user money. The test clock starts at 2026-10-25T05:00Z (12:00 in Bangkok, today =
// 2026-10-25). Every email is @example.test; every password is a made-up test value.

const ADMIN_PW = 'fake-Admin-pw-5832';
const TEMP_PW = 'fake-Temp-pw-2719';
const GiB = 1024 ** 3;

// The cost estimate: R2 8 GiB at 0.125 USD/GB above 0 free GB = 1 USD = 32 THB (3,200 satang),
// plus a VPS bill of 3,068 THB: 3,100 THB (310,000 satang) a month, 10,000 satang a day in a
// 31-day month.
const ENV = shotxEnv({
  ...OFFLINE_ACCOUNTS_ENV,
  ADMIN_MFA_MODE: 'totp',
  R2_STORAGE_GB_MONTH: '0.125',
  R2_FREE_STORAGE_GB: '0',
  USD_THB: '32',
  VPS_MONTH_THB: '3068',
});
const STORAGE_MONTH = 3_200;
const SERVER_MONTH = 306_800;

const PRICES = {
  d3: { price: 39_900, vat: 2_793 },
  d7: { price: 59_900, vat: 4_193 },
} as const;
const total = (code: keyof typeof PRICES) => PRICES[code].price + PRICES[code].vat;

let counter = 0;
const nextIp = () => `203.0.113.${(counter++ % 250) + 1}`;
const email = (label: string) => `${label}-${counter++}@example.test`;
const hex64 = () => randomUUID().replace(/-/g, '').repeat(2);

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`ADR 0027 finance and audit log on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    let boss: { id: string; token: string };
    const packageIds = new Map<string, string>();

    const admin = <T = unknown>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<TestResponse<T>> =>
      api.request<T>(method, path, {
        token: boss.token,
        ...(body === undefined ? {} : { body }),
        headers: { 'x-shotx-bff-key': TEST_ADMIN_BFF_KEY },
      });
    const get = <T = unknown>(path: string, query: Record<string, string | number> = {}) => {
      const search = new URLSearchParams(
        Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString();
      return admin<T>('GET', search === '' ? path : `${path}?${search}`);
    };

    async function photographer(label: string) {
      const res = await admin('POST', apiPath(A.createUser), {
        email: email(label),
        name: `Studio ${label}`,
        role: 'photographer',
        password: TEMP_PW,
      });
      expect(res.status).toBe(201);
      return adminUserSchema.parse(res.body);
    }

    async function insertOrder(o: {
      photographerId: string | null;
      code: keyof typeof PRICES;
      status?: 'pending' | 'paid' | 'failed';
      paidAt?: string;
      createdAt?: string;
      accountCreated?: boolean;
    }) {
      const status = o.status ?? 'paid';
      const paidAt = status === 'paid' ? new Date(o.paidAt ?? '2026-10-01T00:00:00Z') : null;
      const [row] = await api.db
        .insert(packageOrders)
        .values({
          packageId: packageIds.get(o.code) ?? '',
          photographerId: o.photographerId,
          email: 'buyer@example.test',
          priceSatang: PRICES[o.code].price,
          vatSatang: PRICES[o.code].vat,
          totalSatang: total(o.code),
          vatRateBasisPoints: 700,
          gateway: 'fake',
          status,
          accessTokenHash: hex64(),
          idempotencyKey: randomUUID(),
          requestSha256: hex64(),
          accountCreated: o.accountCreated ?? false,
          paidAt,
          appliedAt: paidAt,
          createdAt: new Date(o.createdAt ?? o.paidAt ?? '2026-10-01T00:00:00Z'),
        })
        .returning();
      if (row === undefined) throw new Error('no order');
      return row;
    }

    async function insertCash(photographerId: string, amountSatang: number, paidAt: string) {
      await api.db.insert(cashPayments).values({
        photographerId,
        amountSatang,
        paidAt: new Date(paidAt),
        recordedById: boss.id,
        idempotencyKey: randomUUID(),
        requestSha256: hex64(),
        createdAt: new Date(paidAt),
      });
    }

    async function insertAudit(
      action: string,
      createdAt: string,
      values: { actorId?: string | null; targetType?: string; targetId?: string } = {},
    ) {
      const [row] = await api.db
        .insert(auditLog)
        .values({
          actorId: values.actorId === undefined ? boss.id : values.actorId,
          action,
          targetType: values.targetType ?? 'test',
          targetId: values.targetId ?? randomUUID(),
          meta: { n: counter++ },
          createdAt: new Date(createdAt),
        })
        .returning();
      if (row === undefined) throw new Error('no audit row');
      return row;
    }

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, { env: ENV });
      // The bucket the cost estimate is measured on.
      api.storage.objects.set('originals/x/big.jpg', { size: 8 * GiB, contentType: 'image/jpeg' });
      const admin = api.config.shotxAuth?.admin;
      if (admin === undefined || admin === null) throw new Error('admin sign-in is off');
      const address = email('boss');
      const enrolment = await createTotpAdmin(
        {
          db: api.db,
          stage: api.config.app.stage,
          admin,
          argon2id: api.config.password.argon2id,
          now: () => api.clock.now(),
          operator: 'test-operator',
        },
        { email: address, name: 'Boss', password: ADMIN_PW },
      );
      const bff = (path: string, body: unknown) =>
        api.request('POST', path, {
          body,
          headers: { 'x-shotx-bff-key': bffKeyFor(path, body), 'x-shotx-client-ip': nextIp() },
        });
      api.clock.advance(31_000);
      const login = await bff(apiPath(AR.adminLogin), { email: address, password: ADMIN_PW });
      const step = challengeStep(login.body);
      const code = hotp(
        base32Decode(enrolment.secretBase32),
        totpStep(api.clock.now().getTime(), 30),
        6,
      );
      const mfa = await bff(apiPath(AR.adminMfa), { challengeId: step.challengeId, code });
      expect(mfa.status).toBe(200);
      boss = { id: enrolment.userId, token: authTokenResponseSchema.parse(mfa.body).accessToken };
      for (const p of await api.db.select().from(packages)) packageIds.set(p.code, p.id);
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    it('every ADR 0027 route needs the admin and the admin BFF key', async () => {
      for (const route of [A.auditLog, A.listExpenses, A.finance]) {
        const anon = await api.request('GET', apiPath(route));
        expect(anon.status).toBe(401);
        const noKey = await api.request('GET', apiPath(route), { token: boss.token });
        expect(noKey.status).toBe(401);
      }
    });

    describe('GET /admin/audit-log', () => {
      it('filters by exact action and by a prefix with `_` taken literally', async () => {
        const a = await insertAudit('zzt.a_b.done', '2026-02-01T00:00:00Z');
        const b = await insertAudit('zzt.axb.done', '2026-02-01T00:00:01Z');
        const c = await insertAudit('zzt.a_b', '2026-02-01T00:00:02Z');
        const prefix = listAuditLogResponseSchema.parse(
          (await get(apiPath(A.auditLog), { action: 'zzt.a_b.' })).body,
        );
        expect(prefix.items.map((i) => i.id)).toEqual([a.id]);
        const exact = listAuditLogResponseSchema.parse(
          (await get(apiPath(A.auditLog), { action: 'zzt.a_b' })).body,
        );
        expect(exact.items.map((i) => i.id)).toEqual([c.id]);
        const all = listAuditLogResponseSchema.parse(
          (await get(apiPath(A.auditLog), { action: 'zzt.' })).body,
        );
        expect(all.items.map((i) => i.id)).toEqual([c.id, b.id, a.id]);
        const bad = await get(apiPath(A.auditLog), { action: 'zzt.%' });
        expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });

      it('ORs several action filters, comma-separated or repeated', async () => {
        const paid = await insertAudit('package.zzm_paid', '2026-02-03T00:00:00Z', {
          actorId: null,
        });
        const signup = await insertAudit('zzm.self_signup', '2026-02-03T00:00:01Z');
        const other = await insertAudit('zzm.other', '2026-02-03T00:00:02Z');
        await insertAudit('zzmx.self_signup', '2026-02-03T00:00:03Z');
        const ids = async (search: string) => {
          const res = await admin('GET', `${apiPath(A.auditLog)}?${search}`);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          return listAuditLogResponseSchema
            .parse(res.body)
            .items.filter((i) => i.action.includes('zzm'))
            .map((i) => i.id);
        };
        const expected = [signup.id, paid.id];
        expect(await ids('action=package.,zzm.self_signup')).toEqual(expected);
        expect(await ids('action=package.%2Czzm.self_signup')).toEqual(expected);
        expect(await ids('action=package.&action=zzm.self_signup')).toEqual(expected);
        expect(await ids('action=package.,zzm.self_signup&action=zzm.other')).toEqual([
          other.id,
          ...expected,
        ]);
        // Duplicates are harmless; a single value works as before.
        expect(await ids('action=zzm.other,zzm.other')).toEqual([other.id]);
        expect(await ids('action=zzm.')).toEqual([other.id, signup.id]);
        const tooMany = Array.from({ length: 11 }, (_, i) => `zzm${i}.`).join(',');
        for (const search of [`action=${tooMany}`, 'action=zzm.,', 'action=zzm.,zz%25.']) {
          const res = await admin('GET', `${apiPath(A.auditLog)}?${search}`);
          expect(res.status, search).toBe(400);
          expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
        }
      });

      it('joins the actor and user-target emails; a null actor has none', async () => {
        const p = await photographer('audited');
        const userTarget = await insertAudit('zzj.user', '2026-02-02T00:00:00Z', {
          targetType: 'user',
          targetId: p.id,
        });
        const system = await insertAudit('package.zzj_system', '2026-02-02T00:00:01Z', {
          actorId: null,
          targetType: 'package_order',
          targetId: p.id,
        });
        const notUuid = await insertAudit('zzj.text', '2026-02-02T00:00:02Z', {
          targetType: 'user',
          targetId: 'not-a-uuid',
        });
        const res = await get(apiPath(A.auditLog), { targetId: p.id });
        expect(res.status).toBe(200);
        const page = listAuditLogResponseSchema.parse(res.body);
        const byId = new Map(page.items.map((i) => [i.id, i]));
        expect(byId.get(userTarget.id)).toMatchObject({
          actorId: boss.id,
          targetType: 'user',
          targetEmail: p.email,
          meta: userTarget.meta,
        });
        expect(byId.get(userTarget.id)?.actorEmail).toMatch(/^boss-\d+@example\.test$/);
        // A package_order target never gets an email, even with a user's id.
        expect(byId.get(system.id)).toMatchObject({
          actorId: null,
          actorEmail: null,
          targetEmail: null,
        });
        // The admin.user.created row of the photographer is there too.
        expect(page.items.some((i) => i.action === 'admin.user.created')).toBe(true);
        const text = listAuditLogResponseSchema.parse(
          (await get(apiPath(A.auditLog), { targetId: 'not-a-uuid' })).body,
        );
        expect(text.items).toEqual([
          expect.objectContaining({ id: notUuid.id, targetEmail: null }),
        ]);
        const byActor = listAuditLogResponseSchema.parse(
          (await get(apiPath(A.auditLog), { actorId: boss.id, action: 'zzj.' })).body,
        );
        expect(byActor.items.map((i) => i.id)).toEqual([notUuid.id, userTarget.id]);
      });

      it('from/to are inclusive Bangkok days', async () => {
        const before = await insertAudit('zze.edge', '2026-01-10T16:59:59.999Z'); // Jan 10 BKK
        const first = await insertAudit('zze.edge', '2026-01-10T17:00:00Z'); // Jan 11 00:00 BKK
        const last = await insertAudit('zze.edge', '2026-01-11T16:59:59.999Z'); // Jan 11 BKK
        const after = await insertAudit('zze.edge', '2026-01-11T17:00:00Z'); // Jan 12 BKK
        const ids = async (query: Record<string, string>) =>
          listAuditLogResponseSchema
            .parse((await get(apiPath(A.auditLog), { action: 'zze.edge', ...query })).body)
            .items.map((i) => i.id);
        expect(await ids({ from: '2026-01-11', to: '2026-01-11' })).toEqual([last.id, first.id]);
        expect(await ids({ from: '2026-01-11' })).toEqual([after.id, last.id, first.id]);
        expect(await ids({ to: '2026-01-10' })).toEqual([before.id]);
        const reversed = await get(apiPath(A.auditLog), { from: '2026-01-12', to: '2026-01-11' });
        expect(reversed.status).toBe(400);
        expect(reversed.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });

      it('pages newest first with a keyset cursor (ties broken by id)', async () => {
        const made = [];
        for (const at of [
          '2026-01-20T00:00:00Z',
          '2026-01-20T00:00:00Z',
          '2026-01-20T00:00:00Z',
          '2026-01-21T00:00:00Z',
          '2026-01-19T00:00:00Z',
        ]) {
          made.push(await insertAudit('zzp.page', at));
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const query: Record<string, string | number> = { action: 'zzp.page', limit: 2 };
          if (cursor !== null) query.cursor = cursor;
          const page = listAuditLogResponseSchema.parse(
            (await get(apiPath(A.auditLog), query)).body,
          );
          seen.push(...page.items.map((i) => i.id));
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor !== null && pages < 10);
        expect(pages).toBe(3);
        const expected = [...made]
          .sort((x, y) =>
            x.createdAt.getTime() === y.createdAt.getTime()
              ? y.id > x.id
                ? 1
                : -1
              : y.createdAt.getTime() - x.createdAt.getTime(),
          )
          .map((r) => r.id);
        expect(seen).toEqual(expected);
        const bad = await get(apiPath(A.auditLog), { cursor: 'not-a-cursor' });
        expect(bad.status).toBe(400);
        expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });
    });

    describe('expenses', () => {
      const ledger = async (query: Record<string, string | number>) =>
        listExpensesResponseSchema.parse((await get(apiPath(A.listExpenses), query)).body);

      it('records an expense with its audit row; the note is trimmed and not audited', async () => {
        const res = await admin('POST', apiPath(A.createExpense), {
          spentOn: '2025-12-05',
          amountSatang: 120_000,
          category: 'domain',
          note: '  snap domain renewal  ',
        });
        expect(res.status).toBe(201);
        const expense = expenseSchema.parse(res.body);
        expect(expense).toMatchObject({
          spentOn: '2025-12-05',
          amountSatang: 120_000,
          category: 'domain',
          note: 'snap domain renewal',
          recordedById: boss.id,
        });
        const audits = await api.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, expense.id));
        expect(audits).toEqual([
          expect.objectContaining({
            action: 'finance.expense_created',
            actorId: boss.id,
            targetType: 'expense',
            meta: { spentOn: '2025-12-05', amountSatang: 120_000, category: 'domain' },
          }),
        ]);
        const blank = await admin('POST', apiPath(A.createExpense), {
          spentOn: '2025-12-06',
          amountSatang: 1,
          category: 'other',
          note: '   ',
        });
        expect(expenseSchema.parse(blank.body).note).toBeNull();
      });

      it('spentOn may be at most tomorrow (Bangkok); bad bodies are VALIDATION_FAILED', async () => {
        const tomorrow = await admin('POST', apiPath(A.createExpense), {
          spentOn: '2026-10-26',
          amountSatang: 500,
          category: 'server',
        });
        expect(tomorrow.status).toBe(201);
        const before = (await api.db.select().from(expenses)).length;
        const auditsBefore = (
          await api.db.select().from(auditLog).where(eq(auditLog.action, 'finance.expense_created'))
        ).length;
        for (const body of [
          { spentOn: '2026-10-27', amountSatang: 500, category: 'server' },
          { spentOn: '2025-12-01', amountSatang: 0, category: 'server' },
          { spentOn: '2025-12-01', amountSatang: 1.5, category: 'server' },
          { spentOn: '2025-12-01', amountSatang: 100, category: 'rent' },
          { spentOn: '2025-12-01', amountSatang: 100, category: 'server', note: 'x'.repeat(501) },
          { spentOn: '2025-12-01', amountSatang: 100, category: 'server', extra: true },
        ]) {
          const res = await admin('POST', apiPath(A.createExpense), body);
          expect(res.status, JSON.stringify(body)).toBe(400);
          expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
        }
        expect(await api.db.select().from(expenses)).toHaveLength(before);
        expect(
          await api.db
            .select()
            .from(auditLog)
            .where(eq(auditLog.action, 'finance.expense_created')),
        ).toHaveLength(auditsBefore);
      });

      it('lists live expenses newest spent_on first, by range and cursor', async () => {
        const ids: string[] = [];
        for (const spentOn of ['2025-11-01', '2025-11-02', '2025-11-02', '2025-11-03']) {
          const res = await admin('POST', apiPath(A.createExpense), {
            spentOn,
            amountSatang: 100,
            category: 'marketing',
          });
          ids.push(expenseSchema.parse(res.body).id);
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const query: Record<string, string | number> = {
            from: '2025-11-01',
            to: '2025-11-03',
            limit: 3,
          };
          if (cursor !== null) query.cursor = cursor;
          const page = await ledger(query);
          seen.push(...page.items.map((i) => i.id));
          cursor = page.nextCursor;
        } while (cursor !== null);
        // ids are uuidv7 (creation order): the later of the two 2025-11-02 rows comes first.
        expect(seen).toEqual([ids[3], ids[2], ids[1], ids[0]]);
        expect((await ledger({ from: '2025-11-02', to: '2025-11-02' })).items).toHaveLength(2);
        const bad = await get(apiPath(A.listExpenses), { cursor: 'nope' });
        expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });

      it('deletes softly with an audit row; again is a no-op; unknown is NOT_FOUND', async () => {
        const created = expenseSchema.parse(
          (
            await admin('POST', apiPath(A.createExpense), {
              spentOn: '2025-10-10',
              amountSatang: 7_000,
              category: 'email',
            })
          ).body,
        );
        const del = await admin('DELETE', apiPath(A.deleteExpense, { id: created.id }));
        expect(del.status).toBe(204);
        const [row] = await api.db.select().from(expenses).where(eq(expenses.id, created.id));
        expect(row?.deletedAt).not.toBeNull();
        expect((await ledger({ from: '2025-10-10', to: '2025-10-10' })).items).toEqual([]);
        const again = await admin('DELETE', apiPath(A.deleteExpense, { id: created.id }));
        expect(again.status).toBe(204);
        const audits = await api.db
          .select()
          .from(auditLog)
          .where(
            and(eq(auditLog.targetId, created.id), eq(auditLog.action, 'finance.expense_deleted')),
          );
        expect(audits).toEqual([
          expect.objectContaining({
            actorId: boss.id,
            targetType: 'expense',
            meta: { spentOn: '2025-10-10', amountSatang: 7_000, category: 'email' },
          }),
        ]);
        const unknown = await admin('DELETE', apiPath(A.deleteExpense, { id: randomUUID() }));
        expect(unknown.status).toBe(404);
        expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
      });
    });

    describe('GET /admin/finance', () => {
      const finance = async (query: Record<string, string>) => {
        const res = await get(apiPath(A.finance), query);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return financeResponseSchema.parse(res.body);
      };

      let p1: { id: string; email: string | null; name: string | null };
      let p2: { id: string; email: string | null; name: string | null };

      it('buckets income and expenses by Bangkok day, zero-filled, with the totals', async () => {
        p1 = await photographer('buyer-one');
        p2 = await photographer('buyer-two');
        // 2026-03-30 .. 2026-04-02 (Bangkok). Edges: 16:59:59Z is 23:59:59 the same Bangkok day.
        await insertOrder({ photographerId: p1.id, code: 'd7', paidAt: '2026-03-29T16:59:59Z' }); // out
        await insertOrder({ photographerId: p1.id, code: 'd7', paidAt: '2026-03-29T17:00:00Z' }); // 03-30
        await insertOrder({
          photographerId: p1.id,
          code: 'd3',
          paidAt: '2026-03-30T17:00:00Z', // 03-31
          accountCreated: true,
        });
        await insertOrder({ photographerId: p2.id, code: 'd7', paidAt: '2026-04-02T16:59:59Z' }); // 04-02
        await insertOrder({ photographerId: p2.id, code: 'd7', paidAt: '2026-04-02T17:00:00Z' }); // out
        await insertOrder({
          photographerId: p2.id,
          code: 'd7',
          status: 'pending',
          createdAt: '2026-03-31T00:00:00Z',
        });
        await insertOrder({
          photographerId: p2.id,
          code: 'd3',
          status: 'failed',
          createdAt: '2026-03-31T00:00:00Z',
        });
        await insertCash(p2.id, 200_000, '2026-04-01T05:00:00Z'); // 04-01
        await insertCash(p2.id, 999, '2026-04-02T17:00:00Z'); // out
        const expense = async (spentOn: string, amountSatang: number) =>
          expenseSchema.parse(
            (
              await admin('POST', apiPath(A.createExpense), {
                spentOn,
                amountSatang,
                category: 'payment_fee',
              })
            ).body,
          );
        await expense('2026-04-01', 3_000);
        await expense('2026-03-30', 1_000);
        await expense('2026-04-03', 50); // out
        const gone = await expense('2026-04-01', 77);
        await admin('DELETE', apiPath(A.deleteExpense, { id: gone.id }));
        await insertAudit('account.self_signup', '2026-03-31T10:00:00Z', {
          actorId: p1.id,
          targetType: 'user',
          targetId: p1.id,
        });
        await insertAudit('account.self_signup', '2026-04-02T17:00:00Z', {
          actorId: p2.id,
          targetType: 'user',
          targetId: p2.id,
        }); // out

        const f = await finance({ from: '2026-03-30', to: '2026-04-02' });
        expect(f.range).toEqual({ from: '2026-03-30', to: '2026-04-02', bucket: 'day' });
        expect(f.series).toEqual([
          {
            bucket: '2026-03-30',
            packageIncomeSatang: total('d7'),
            cashIncomeSatang: 0,
            vatSatang: PRICES.d7.vat,
            manualExpenseSatang: 1_000,
            estimatedCostSatang: 10_000, // 310,000 / 31
          },
          {
            bucket: '2026-03-31',
            packageIncomeSatang: total('d3'),
            cashIncomeSatang: 0,
            vatSatang: PRICES.d3.vat,
            manualExpenseSatang: 0,
            estimatedCostSatang: 10_000,
          },
          {
            bucket: '2026-04-01',
            packageIncomeSatang: 0,
            cashIncomeSatang: 200_000,
            vatSatang: 0,
            manualExpenseSatang: 3_000,
            estimatedCostSatang: 10_333, // 310,000 / 30
          },
          {
            bucket: '2026-04-02',
            packageIncomeSatang: total('d7'),
            cashIncomeSatang: 0,
            vatSatang: PRICES.d7.vat,
            manualExpenseSatang: 0,
            estimatedCostSatang: 10_333,
          },
        ]);
        const packageIncome = 2 * total('d7') + total('d3');
        const vat = 2 * PRICES.d7.vat + PRICES.d3.vat;
        const estimated = 2 * 10_000 + 2 * 10_333;
        expect(f.totals).toEqual({
          incomeSatang: packageIncome + 200_000,
          packageIncomeSatang: packageIncome,
          cashIncomeSatang: 200_000,
          vatSatang: vat,
          netIncomeSatang: packageIncome + 200_000 - vat,
          manualExpenseSatang: 4_000,
          estimatedCostSatang: estimated,
          expenseSatang: 4_000 + estimated,
          profitSatang: packageIncome + 200_000 - vat - 4_000 - estimated,
          ordersPaid: 3,
          buyers: 2,
          freeSignups: 1,
          paidSignups: 1,
        });
        expect(f.packageMix).toEqual([
          { code: 'd7', name: '7 Days', orders: 2, incomeSatang: 2 * total('d7') },
          { code: 'd3', name: '3 Days', orders: 1, incomeSatang: total('d3') },
        ]);
        // p2: one order + cash 200,000 beats p1's two orders.
        expect(f.topCustomers).toEqual([
          {
            userId: p2.id,
            email: p2.email,
            name: p2.name,
            orders: 1,
            paidSatang: total('d7') + 200_000,
          },
          {
            userId: p1.id,
            email: p1.email,
            name: p1.name,
            orders: 2,
            paidSatang: total('d7') + total('d3'),
          },
        ]);
      });

      it('buckets by Bangkok month (partial months included); the estimate per calendar day', async () => {
        const f = await finance({ from: '2026-03-15', to: '2026-05-10', bucket: 'month' });
        expect(f.series.map((p) => p.bucket)).toEqual(['2026-03', '2026-04', '2026-05']);
        expect(f.series.map((p) => p.estimatedCostSatang)).toEqual([
          17 * 10_000, // March 15-31
          310_000, // all of April
          100_000, // May 1-10 (31-day month)
        ]);
        expect(f.series.map((p) => p.packageIncomeSatang)).toEqual([
          2 * total('d7') + total('d3'), // incl. the order paid 03-29 23:59 Bangkok
          2 * total('d7'), // 04-02 and 04-03 00:00 Bangkok
          0,
        ]);
        expect(f.series.map((p) => p.cashIncomeSatang)).toEqual([0, 200_999, 0]);
        expect(f.series.map((p) => p.vatSatang)).toEqual([
          2 * PRICES.d7.vat + PRICES.d3.vat,
          2 * PRICES.d7.vat,
          0,
        ]);
        expect(f.totals.vatSatang).toBe(4 * PRICES.d7.vat + PRICES.d3.vat);
        expect(f.totals.estimatedCostSatang).toBe(580_000);
      });

      it('accrues no estimate after today, and defaults to the last 30 days by day', async () => {
        const f = await finance({ from: '2026-10-20', to: '2026-10-31' });
        expect(f.series.map((p) => p.estimatedCostSatang)).toEqual([
          ...Array<number>(6).fill(10_000), // 20 .. 25 (today)
          ...Array<number>(6).fill(0),
        ]);
        expect(f.totals.estimatedCostSatang).toBe(60_000);
        const fallback = await finance({});
        expect(fallback.range).toEqual({ from: '2026-09-26', to: '2026-10-25', bucket: 'day' });
        expect(fallback.series).toHaveLength(30);
        expect(fallback.series[0]?.bucket).toBe('2026-09-26');
      });

      it('rejects reversed, too long and future-only ranges', async () => {
        const queries: Record<string, string>[] = [
          { from: '2026-04-02', to: '2026-04-01' },
          { from: '2025-01-01', to: '2026-01-02' }, // 367 days by day
          { from: '2026-12-01' }, // after today, so after the default `to`
          { bucket: 'week' },
        ];
        for (const query of queries) {
          const res = await get(apiPath(A.finance), query);
          expect(res.status, JSON.stringify(query)).toBe(400);
          expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
        }
        expect(
          (await get(apiPath(A.finance), { from: '2025-01-01', to: '2026-01-02', bucket: 'month' }))
            .status,
        ).toBe(200);
      });
    });

    describe('per-user money', () => {
      it('GET /admin/users/:id/finance: orders, payments, usage and the cost allocation', async () => {
        const p = await photographer('allocated');
        const other = await photographer('other-usage');
        // The account dates from 2026-10-01 (Bangkok): 25 days of October to today.
        await api.db
          .update(users)
          .set({ createdAt: new Date('2026-09-30T17:00:00Z') })
          .where(eq(users.id, p.id));
        await insertOrder({
          photographerId: p.id,
          code: 'd3',
          status: 'failed',
          createdAt: '2026-10-02T00:00:00Z',
        });
        const paid = await insertOrder({
          photographerId: p.id,
          code: 'd7',
          paidAt: '2026-10-03T00:00:00Z',
        });
        await insertCash(p.id, 50_000, '2026-10-05T00:00:00Z');
        await insertCash(p.id, 10_000, '2026-10-02T12:00:00Z');
        await insertReadyFile(api.db, p.id, { name: 'a.jpg' });
        await insertReadyFile(api.db, p.id, { name: 'b.jpg' });
        await insertReadyFile(api.db, p.id, { name: 'trashed.jpg', deletedAt: new Date() });
        await insertReadyFile(api.db, p.id, { name: 'clip.mp4', mime: 'video/mp4' });
        // Shares: storage 1,000 of 4,000 bytes (25%); served 600 of 2,000 bytes (30%).
        await api.db.update(storageUsage).set({ usedBytes: 0 });
        await api.db
          .update(storageUsage)
          .set({ usedBytes: 1_000 })
          .where(eq(storageUsage.photographerId, p.id));
        await api.db
          .update(storageUsage)
          .set({ usedBytes: 3_000 })
          .where(eq(storageUsage.photographerId, other.id));
        await api.db.insert(dailyStats).values([
          { date: '2026-10-10', photographerId: p.id, bytesOut: 200 },
          { date: '2026-10-11', photographerId: p.id, bytesOut: 400 },
          { date: '2026-10-10', photographerId: other.id, bytesOut: 1_400 },
        ]);

        const res = await get(apiPath(A.userFinance, { id: p.id }));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const f = adminUserFinanceResponseSchema.parse(res.body);
        expect(f.orders.map((o) => [o.packageCode, o.status])).toEqual([
          ['d7', 'paid'],
          ['d3', 'failed'],
        ]);
        expect(f.orders[0]).toEqual({
          id: paid.id,
          packageCode: 'd7',
          packageName: '7 Days',
          status: 'paid',
          totalSatang: total('d7'),
          vatSatang: PRICES.d7.vat,
          createdAt: '2026-10-03T00:00:00.000Z',
          paidAt: '2026-10-03T00:00:00.000Z',
        });
        const months = 25 / 31;
        const storage = Math.round(STORAGE_MONTH * 0.25 * months); // 645
        const server = Math.round(SERVER_MONTH * 0.3 * months); // 74,226
        expect(storage).toBe(645);
        expect(server).toBe(74_226);
        expect(f).toMatchObject({
          ordersPaid: 1,
          paidSatang: total('d7'),
          netPaidSatang: PRICES.d7.price,
          cashPaidSatang: 60_000,
          firstPaidAt: '2026-10-02T12:00:00.000Z',
          lastPaidAt: '2026-10-05T00:00:00.000Z',
          usage: { storageBytes: 1_000, bytesServed: 600, photosUploaded: 2 },
          estimatedCostSatang: { storage, server, total: storage + server },
          // Net of VAT (owner 2026-11-16): 59,900 + 60,000 − 74,871.
          profitSatang: PRICES.d7.price + 60_000 - storage - server,
        });
      });

      it('an account that never paid or used anything costs nothing; admins and unknowns are NOT_FOUND', async () => {
        const idle = await photographer('idle');
        const f = adminUserFinanceResponseSchema.parse(
          (await get(apiPath(A.userFinance, { id: idle.id }))).body,
        );
        expect(f).toEqual({
          orders: [],
          ordersPaid: 0,
          paidSatang: 0,
          netPaidSatang: 0,
          cashPaidSatang: 0,
          firstPaidAt: null,
          lastPaidAt: null,
          usage: { storageBytes: 0, bytesServed: 0, photosUploaded: 0 },
          estimatedCostSatang: { storage: 0, server: 0, total: 0 },
          profitSatang: 0,
        });
        for (const id of [boss.id, randomUUID()]) {
          const res = await get(apiPath(A.userFinance, { id }));
          expect(res.status).toBe(404);
          expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
        }
      });

      it(`lists at most ${ADMIN_USER_FINANCE_MAX_ORDERS} orders, newest first; totals cover all`, async () => {
        const p = await photographer('many');
        for (let i = 0; i <= ADMIN_USER_FINANCE_MAX_ORDERS; i++) {
          await insertOrder({
            photographerId: p.id,
            code: 'd3',
            paidAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
          });
        }
        const f = adminUserFinanceResponseSchema.parse(
          (await get(apiPath(A.userFinance, { id: p.id }))).body,
        );
        expect(f.orders).toHaveLength(ADMIN_USER_FINANCE_MAX_ORDERS);
        expect(f.orders[0]?.createdAt).toBe(
          new Date(Date.UTC(2026, 8, 1) + ADMIN_USER_FINANCE_MAX_ORDERS * 60_000).toISOString(),
        );
        expect(f.ordersPaid).toBe(ADMIN_USER_FINANCE_MAX_ORDERS + 1);
        expect(f.paidSatang).toBe((ADMIN_USER_FINANCE_MAX_ORDERS + 1) * total('d3'));
      });

      it('the users list and detail carry ordersPaid and paidSatang (packages + cash)', async () => {
        const buyer = await photographer('listed');
        const nobody = await photographer('listed-none');
        await insertOrder({ photographerId: buyer.id, code: 'd7', paidAt: '2026-10-10T00:00:00Z' });
        await insertOrder({ photographerId: buyer.id, code: 'd3', paidAt: '2026-10-11T00:00:00Z' });
        await insertOrder({ photographerId: buyer.id, code: 'd3', status: 'failed' });
        await insertCash(buyer.id, 25_000, '2026-10-12T00:00:00Z');
        const detail = adminUserSchema.parse(
          (await get(apiPath(A.getUser, { id: buyer.id }))).body,
        );
        expect(detail).toMatchObject({
          ordersPaid: 2,
          paidSatang: total('d7') + total('d3') + 25_000,
        });
        const list = listAdminUsersResponseSchema.parse(
          (await get(apiPath(A.listUsers), { limit: 100 })).body,
        );
        const byId = new Map(list.items.map((u) => [u.id, u]));
        expect(byId.get(buyer.id)).toMatchObject({
          ordersPaid: 2,
          paidSatang: total('d7') + total('d3') + 25_000,
        });
        expect(byId.get(nobody.id)).toMatchObject({ ordersPaid: 0, paidSatang: 0 });
        expect(byId.get(boss.id)).toMatchObject({ ordersPaid: null, paidSatang: null });
        // One row per account: the aggregates don't multiply rows.
        expect(list.items.filter((u) => u.id === buyer.id)).toHaveLength(1);
        const rowCount = await api.db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.role, ['admin', 'photographer']));
        expect(list.items).toHaveLength(rowCount.length);
      });
    });

    it('the estimate falls back to the recorded originals when the bucket cannot be listed', async () => {
      const system = api.app.get(AdminSystemService);
      expect(await system.monthlyCost()).toEqual({
        storageSatangMonth: STORAGE_MONTH,
        serverSatangMonth: SERVER_MONTH,
      });
      const unlisted = new FakeObjectStorage();
      unlisted.failBucketUsage = true;
      const fallback = new AdminSystemService(
        api.db,
        api.config,
        api.clock,
        unlisted,
        nodeMetricsSource,
      );
      await api.db.update(storageUsage).set({ usedBytes: 0 });
      const [any] = await api.db.select().from(storageUsage).limit(1);
      await api.db
        .update(storageUsage)
        .set({ usedBytes: 4 * GiB })
        .where(eq(storageUsage.photographerId, any?.photographerId ?? ''));
      // 4 GiB × 0.125 USD × 32 THB = 16 THB.
      expect(await fallback.monthlyCost()).toEqual({
        storageSatangMonth: 1_600,
        serverSatangMonth: SERVER_MONTH,
      });
    });
  });
}
