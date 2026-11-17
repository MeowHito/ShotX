import { randomUUID } from 'node:crypto';
import {
  auditLog,
  packageOrders,
  packages,
  photographerPackages,
  userPasswordCredentials,
  users,
} from '@shotx/db';
import {
  apiPath,
  AUTH_ROUTES as AR,
  authTokenResponseSchema,
  type AuthTokenResponse,
  createPackageOrderResponseSchema,
  myPackageResponseSchema,
  ORDER_TOKEN_HEADER,
  loadPackageGatewayConfig,
  PACKAGE_ROUTES as R,
  type PackageCallback,
  packageOrderViewSchema,
  packagesResponseSchema,
  SIGNUP_CONFIRM_PATH,
  startPackagePaymentResponseSchema,
} from '@shotx/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAccountMailer } from '../auth/account-email';
import { hashPassword } from '../auth/password';
import { PhotographerSignIn } from '../auth/photographer-sign-in';
import { FakeCaptchaVerifier } from '../public/captcha';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { OFFLINE_ACCOUNTS_ENV } from '../testing/fakes';
import { TestApi, type TestResponse } from '../testing/harness';
import { bffKeyFor, shotxEnv } from '../testing/shotx-auth';
import {
  FAKE_PACKAGE_SIGNATURE_HEADER,
  FakePackageGateway,
  MPAY_HEADERS,
  MPAY_PATHS,
  MpayPackageGateway,
} from './gateways';
import { orderTokenHash, PackagesService } from './packages.service';

// ADR 0026 end to end: Free sign-up by email, paid orders through the fake gateway (fake-result,
// signed callbacks, inquiries), the kill switch and the gateway being off. Every email is
// @example.test; every password is a made-up test value.

const PW = 'fake-Signup-pw-6183';
const SET_PW = 'fake-SetPw-pw-2750';
const DAY = 24 * 3600 * 1000;

const ENV = shotxEnv({
  ...OFFLINE_ACCOUNTS_ENV,
  ACCOUNT_EMAIL_PROVIDER: 'fake',
  PACKAGE_SALES: 'on',
  PACKAGE_GATEWAY: 'fake',
  SIGNUP_RATE_PER_IP: '1000',
  PACKAGE_ORDER_RATE_PER_IP: '1000',
});

let counter = 0;
const nextIp = () => `198.51.100.${(counter++ % 250) + 1}`;
const newEmail = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@example.test`;

/** The token in the last email to `to` that links to `path`. */
function linkToken(mailer: FakeAccountMailer, to: string, path: string): string {
  const message = mailer.sent.filter((m) => m.to === to).at(-1);
  if (message === undefined) throw new Error(`no email to ${to}`);
  const escaped = path.replace(/[/]/g, '\\/');
  const match = new RegExp(`${escaped}#token=([A-Za-z0-9_-]{43})`).exec(message.text);
  if (match?.[1] === undefined) throw new Error(`no ${path} link in the email`);
  return match[1];
}

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`ADR 0026 packages on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    const mailer = new FakeAccountMailer();
    const gateway = new FakePackageGateway('http://localhost:3000', Buffer.alloc(32, 7));

    const bff = <T = unknown>(
      method: string,
      path: string,
      options: { body?: unknown; headers?: Record<string, string>; token?: string } = {},
    ): Promise<TestResponse<T>> =>
      api.request<T>(method, path, {
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.token === undefined ? {} : { token: options.token }),
        headers: {
          'x-shotx-bff-key': bffKeyFor(path, options.body),
          'x-shotx-client-ip': nextIp(),
          ...options.headers,
        },
      });
    const settled = async () => {
      await api.app.get(PackagesService).settled();
      await api.app.get(PhotographerSignIn).settled();
    };

    const signupFree = async (email: string, name = 'ช่างภาพทดสอบ') => {
      const res = await bff('POST', apiPath(R.signupFree), { body: { name, email } });
      await settled();
      return res;
    };
    const confirm = (token: string, password = PW) =>
      bff<AuthTokenResponse>('POST', apiPath(R.signupFreeConfirm), { body: { token, password } });
    /** A self-signed-up Free photographer: its id, email and session. */
    async function freePhotographer() {
      const email = newEmail('free');
      expect((await signupFree(email)).status).toBe(204);
      const res = await confirm(linkToken(mailer, email, SIGNUP_CONFIRM_PATH));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const session = authTokenResponseSchema.parse(res.body);
      const [row] = await api.db.select().from(users).where(eq(users.email, email));
      if (row === undefined) throw new Error('no account');
      return { id: row.id, email, session };
    }

    const order = (body: Record<string, unknown>, options: { key?: string; token?: string } = {}) =>
      bff<unknown>('POST', apiPath(R.createOrder), {
        body,
        headers: { 'idempotency-key': options.key ?? randomUUID() },
        ...(options.token === undefined ? {} : { token: options.token }),
      });
    async function newOrder(body: Record<string, unknown>, token?: string) {
      const res = await order(body, token === undefined ? {} : { token });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return createPackageOrderResponseSchema.parse(res.body);
    }
    const getOrder = (id: string, token: string | undefined) =>
      bff('GET', apiPath(R.getOrder, { id }), {
        headers: token === undefined ? {} : { [ORDER_TOKEN_HEADER]: token },
      });
    const fakeResult = (id: string, token: string, result: 'paid' | 'failed') =>
      bff('POST', apiPath(R.fakeResult, { id }), {
        body: { result },
        headers: { [ORDER_TOKEN_HEADER]: token },
      }).then(async (res) => {
        await settled();
        return res;
      });
    const webhook = async (callback: PackageCallback, signature?: string) => {
      const raw = JSON.stringify(callback);
      const res = await api.request('POST', apiPath(R.webhook, { gateway: 'fake' }), {
        rawBody: raw,
        headers: { [FAKE_PACKAGE_SIGNATURE_HEADER]: signature ?? gateway.sign(raw) },
      });
      await settled();
      return res;
    };
    const orderRow = async (id: string) =>
      (await api.db.select().from(packageOrders).where(eq(packageOrders.id, id)))[0];
    const packageRow = async (photographerId: string) =>
      (
        await api.db
          .select()
          .from(photographerPackages)
          .where(eq(photographerPackages.photographerId, photographerId))
      )[0];
    const audits = (action: string, targetId: string) =>
      api.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));

    /** A photographer password account without a package (admin-created, unlimited). */
    async function unlimitedPhotographer(status: 'active' | 'disabled' = 'active') {
      const email = newEmail('legacy');
      const [row] = await api.db
        .insert(users)
        .values({
          email,
          name: 'ช่างภาพเดิม',
          role: 'photographer',
          authPool: 'users',
          authSubject: `password:${randomUUID()}`,
          status,
          ...(status === 'disabled' ? { disabledAt: api.clock.now() } : {}),
        })
        .returning({ id: users.id });
      if (row === undefined) throw new Error('insert failed');
      await api.db.insert(userPasswordCredentials).values({
        userId: row.id,
        passwordHash: await hashPassword(PW, api.config.password.argon2id),
        mustChangePassword: false,
      });
      return { id: row.id, email };
    }

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, {
        env: ENV,
        accountMailer: mailer,
        packageGateway: gateway,
      });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    describe('GET /packages', () => {
      it('lists the five packages with VAT on top and the sales switches', async () => {
        const res = await api.request('GET', apiPath(R.list));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('public, max-age=60');
        const body = packagesResponseSchema.parse(res.body);
        expect(body.packages.map((p) => p.code)).toEqual(['free', 'd3', 'd7', 'd15', 'd30']);
        expect(body.packages.find((p) => p.code === 'd3')?.price).toEqual({
          priceSatang: 39_900,
          vatSatang: 2_793,
          totalSatang: 42_693,
          vatRateBasisPoints: 700,
        });
        expect(body.packages.filter((p) => p.featured).map((p) => p.code)).toEqual(['d7']);
        expect(body.packages.find((p) => p.free)?.price.totalSatang).toBe(0);
        expect(body.sales).toEqual({
          salesEnabled: true,
          featuredCode: 'd7',
          onlinePayment: true,
        });
      });
    });

    describe('Free sign-up', () => {
      it('answers 204 for a new email and creates the account on confirm', async () => {
        const email = newEmail('new');
        const res = await signupFree(email, 'คุณใหม่');
        expect(res.status).toBe(204);
        const message = mailer.sent.filter((m) => m.to === email).at(-1);
        expect(message?.subject).toContain('Snap');
        expect(message?.text).toContain(`http://localhost:3000${SIGNUP_CONFIRM_PATH}#token=`);
        expect(message?.html).toContain('ยืนยันอีเมล');
        // The typed name is unverified: never repeated in the email.
        expect(message?.text).not.toContain('คุณใหม่');
        expect(message?.html).not.toContain('คุณใหม่');
        // Nothing exists until the link is used.
        expect(await api.db.select().from(users).where(eq(users.email, email))).toEqual([]);

        const token = linkToken(mailer, email, SIGNUP_CONFIRM_PATH);
        const done = await confirm(token);
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        const session = authTokenResponseSchema.parse(done.body);
        expect(session.user).toEqual({ email, name: 'คุณใหม่' });

        const [user] = await api.db.select().from(users).where(eq(users.email, email));
        expect(user).toMatchObject({ role: 'photographer', status: 'active', createdById: null });
        expect(user?.authSubject).toMatch(/^password:/);
        const [cred] = await api.db
          .select()
          .from(userPasswordCredentials)
          .where(eq(userPasswordCredentials.userId, user?.id ?? ''));
        expect(cred?.mustChangePassword).toBe(false);
        expect(cred?.passwordHash).not.toContain(PW);

        const now = api.clock.now().getTime();
        const pkg = await packageRow(user?.id ?? '');
        expect(pkg).toMatchObject({ photoLimit: 100, photosUsed: 0 });
        expect(pkg?.expiresAt.getTime()).toBe(now + 3 * DAY);
        const [audit] = await audits('account.self_signup', user?.id ?? '');
        expect(audit).toMatchObject({ actorId: user?.id, targetType: 'user' });
        expect(audit?.meta).toMatchObject({ package: 'free' });
        expect(JSON.stringify(audit?.meta)).not.toContain(email);

        // The session works on photographer routes: GET /me/package.
        const mine = await api.request('GET', apiPath(R.myPackage), {
          token: session.accessToken,
        });
        expect(mine.status).toBe(200);
        expect(myPackageResponseSchema.parse(mine.body)).toMatchObject({
          code: 'free',
          name: 'Free',
          photoLimit: 100,
          photosUsed: 0,
          expired: false,
        });

        // Single use.
        expect(await confirm(token)).toMatchObject({
          status: 400,
          body: { code: 'SIGNUP_LINK_INVALID' },
        });
        // Free can't be taken twice: the email now has an account.
        mailer.sent.length = 0;
        expect((await signupFree(email)).status).toBe(204);
        expect(mailer.sent.map((m) => m.subject)).toEqual(['คุณมีบัญชี Snap อยู่แล้ว']);
      });

      it('answers 204 for an existing account and sends "you already have an account"', async () => {
        const legacy = await unlimitedPhotographer();
        mailer.sent.length = 0;
        const res = await signupFree(legacy.email.toUpperCase());
        expect(res.status).toBe(204);
        expect(mailer.sent).toHaveLength(1);
        const message = mailer.sent[0];
        expect(message?.to).toBe(legacy.email);
        expect(message?.text).toContain('http://localhost:3000/login');
        expect(message?.text).toContain('http://localhost:3000/forgot-password');
        expect(message?.text).not.toContain('#token=');
        expect(await packageRow(legacy.id)).toBeUndefined();
      });

      it('keeps the link usable after a weak password, and refuses unknown tokens', async () => {
        const email = newEmail('weak');
        await signupFree(email);
        const token = linkToken(mailer, email, SIGNUP_CONFIRM_PATH);
        expect(await confirm(token, 'short')).toMatchObject({
          status: 422,
          body: { code: 'PASSWORD_TOO_WEAK' },
        });
        expect((await confirm(token)).status).toBe(200);
        expect(await confirm('A'.repeat(43))).toMatchObject({
          status: 400,
          body: { code: 'SIGNUP_LINK_INVALID' },
        });
      });

      it('refuses the link when the email got an account meanwhile', async () => {
        const email = newEmail('race');
        await signupFree(email);
        const token = linkToken(mailer, email, SIGNUP_CONFIRM_PATH);
        await api.db.insert(users).values({
          email: email.toUpperCase(),
          name: 'ทำโดยแอดมิน',
          role: 'photographer',
          authPool: 'users',
          authSubject: `password:${randomUUID()}`,
        });
        expect(await confirm(token)).toMatchObject({
          status: 400,
          body: { code: 'SIGNUP_LINK_INVALID' },
        });
      });

      it('sends at most SIGNUP_EMAILS_PER_HOUR emails per address', async () => {
        const email = newEmail('flood');
        for (let i = 0; i < 5; i++) expect((await signupFree(email)).status).toBe(204);
        expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(3);
      });

      it('rejects malformed bodies and wrong BFF keys', async () => {
        expect(
          (await bff('POST', apiPath(R.signupFree), { body: { email: 'not-an-email', name: 'x' } }))
            .status,
        ).toBe(400);
        const res = await api.request('POST', apiPath(R.signupFree), {
          body: { email: newEmail('nokey'), name: 'x' },
        });
        expect(res).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } });
      });
    });

    describe('orders', () => {
      it('creates an anonymous order and polls it with its token only', async () => {
        const email = newEmail('buyer');
        const created = await newOrder({ packageCode: 'd7', email, name: 'ผู้ซื้อ' });
        expect(created.redirectUrl).toBe(
          `http://localhost:3000/checkout/fake?order=${created.orderId}`,
        );
        const row = await orderRow(created.orderId);
        expect(row).toMatchObject({
          status: 'pending',
          photographerId: null,
          email,
          priceSatang: 59_900,
          vatSatang: 4_193,
          totalSatang: 64_093,
          gateway: 'fake',
          gatewayRef: `fake_${created.orderId}`,
          accessTokenHash: orderTokenHash(created.accessToken),
          redirectUrl: created.redirectUrl,
        });
        expect(gateway.checkouts.at(-1)).toMatchObject({
          orderId: created.orderId,
          amountSatang: 64_093,
          description: 'Snap 7 Days',
          returnUrl: 'http://localhost:3000/checkout/return',
          callbackUrl: 'http://localhost:3000/api/package-payments/webhooks/fake',
        });

        const view = await getOrder(created.orderId, created.accessToken);
        expect(view.status).toBe(200);
        expect(packageOrderViewSchema.parse(view.body)).toEqual({
          status: 'pending',
          packageCode: 'd7',
          packageName: '7 Days',
          totalSatang: 64_093,
          emailMasked: `${email[0]}***@example.test`,
          accountCreated: false,
          expiresAt: null,
          // The fake gateway has its own page: nothing for Snap's pay page.
          paymentMethods: [],
        });
        for (const token of [undefined, 'B'.repeat(43), 'short']) {
          expect(await getOrder(created.orderId, token)).toMatchObject({
            status: 404,
            body: { code: 'ORDER_NOT_FOUND' },
          });
        }
        expect(await getOrder(randomUUID(), created.accessToken)).toMatchObject({
          status: 404,
          body: { code: 'ORDER_NOT_FOUND' },
        });
      });

      it('needs email and name when anonymous, and refuses free or unknown packages', async () => {
        expect(await order({ packageCode: 'd7', name: 'x' })).toMatchObject({
          status: 400,
          body: { code: 'VALIDATION_FAILED', details: { issues: [{ path: ['body', 'email'] }] } },
        });
        expect(await order({ packageCode: 'd7', email: newEmail('n') })).toMatchObject({
          status: 400,
          body: { details: { issues: [{ path: ['body', 'name'] }] } },
        });
        for (const packageCode of ['free', 'nope']) {
          expect(await order({ packageCode, email: newEmail('p'), name: 'x' })).toMatchObject({
            status: 404,
            body: { code: 'PACKAGE_UNAVAILABLE' },
          });
        }
        const missingKey = await bff('POST', apiPath(R.createOrder), {
          body: { packageCode: 'd7', email: newEmail('k'), name: 'x' },
        });
        expect(missingKey).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
      });

      it('refuses admin, disabled and unlimited emails with one code', async () => {
        const adminEmail = newEmail('admin');
        await api.db.insert(users).values({
          email: adminEmail,
          role: 'admin',
          authPool: 'admins',
          authSubject: `admin:${randomUUID()}`,
        });
        const disabled = await unlimitedPhotographer('disabled');
        const unlimited = await unlimitedPhotographer();
        for (const email of [adminEmail, disabled.email, unlimited.email.toUpperCase()]) {
          expect(await order({ packageCode: 'd3', email, name: 'x' })).toMatchObject({
            status: 409,
            body: { code: 'EMAIL_UNAVAILABLE' },
          });
        }
      });

      it('replays the same request per Idempotency-Key with a new token', async () => {
        const key = randomUUID();
        const body = { packageCode: 'd15', email: newEmail('idem'), name: 'ผู้ซื้อ' };
        const first = createPackageOrderResponseSchema.parse((await order(body, { key })).body);
        const replay = await order(body, { key });
        expect(replay.status).toBe(201);
        const second = createPackageOrderResponseSchema.parse(replay.body);
        expect(second.orderId).toBe(first.orderId);
        expect(second.redirectUrl).toBe(first.redirectUrl);
        expect(second.accessToken).not.toBe(first.accessToken);
        expect((await getOrder(first.orderId, first.accessToken)).status).toBe(404);
        expect((await getOrder(first.orderId, second.accessToken)).status).toBe(200);
        expect(await order({ ...body, packageCode: 'd30' }, { key })).toMatchObject({
          status: 422,
          body: { code: 'IDEMPOTENCY_KEY_REUSED' },
        });
        const rows = await api.db
          .select()
          .from(packageOrders)
          .where(eq(packageOrders.idempotencyKey, key));
        expect(rows).toHaveLength(1);
      });

      it('answers PAYMENT_GATEWAY_ERROR when the gateway fails, and a retry recovers', async () => {
        const key = randomUUID();
        const body = { packageCode: 'd3', email: newEmail('outage'), name: 'x' };
        gateway.failNext();
        expect(await order(body, { key })).toMatchObject({
          status: 502,
          body: { code: 'PAYMENT_GATEWAY_ERROR' },
        });
        const retry = await order(body, { key });
        expect(retry.status).toBe(201);
        const { orderId } = createPackageOrderResponseSchema.parse(retry.body);
        expect((await orderRow(orderId))?.redirectUrl).toContain(orderId);
      });

      it('fake pay creates the account and emails a set-password link', async () => {
        const email = newEmail('paid');
        const created = await newOrder({ packageCode: 'd7', email, name: 'ผู้ซื้อใหม่' });
        mailer.sent.length = 0;
        const res = await fakeResult(created.orderId, created.accessToken, 'paid');
        expect(res.status).toBe(200);
        const now = api.clock.now().getTime();
        expect(packageOrderViewSchema.parse(res.body)).toMatchObject({
          status: 'paid',
          accountCreated: true,
          expiresAt: new Date(now + 7 * DAY).toISOString(),
        });

        const [user] = await api.db.select().from(users).where(eq(users.email, email));
        expect(user).toMatchObject({
          role: 'photographer',
          createdById: null,
          name: 'ผู้ซื้อใหม่',
        });
        expect(await packageRow(user?.id ?? '')).toMatchObject({ photoLimit: 3000, photosUsed: 0 });
        const row = await orderRow(created.orderId);
        expect(row).toMatchObject({
          status: 'paid',
          photographerId: user?.id,
          accountCreated: true,
        });
        expect(row?.paidAt).not.toBeNull();
        expect(row?.appliedAt).not.toBeNull();
        const [audit] = await audits('package.order_paid', created.orderId);
        expect(audit).toMatchObject({ actorId: user?.id, targetType: 'package_order' });
        expect(audit?.meta).toEqual({
          orderId: created.orderId,
          package: 'd7',
          totalSatang: 64_093,
          accountCreated: true,
        });

        expect(mailer.sent).toHaveLength(1);
        const message = mailer.sent[0];
        expect(message?.to).toBe(email);
        expect(message?.subject).toContain('ตั้งรหัสผ่าน');
        expect(message?.text).toContain('7 Days');
        expect(message?.text).toContain('640.93 บาท');
        expect(message?.text).toContain('7 วัน');
        // The ADR 0025 reset page sets the password and signs in.
        const token = linkToken(mailer, email, '/reset-password');
        const set = await bff('POST', apiPath(AR.photographerPasswordResetConfirm), {
          body: { token, newPassword: SET_PW },
        });
        expect(set.status, JSON.stringify(set.body)).toBe(200);
        expect(authTokenResponseSchema.parse(set.body).user.email).toBe(email);
        // The link lives PACKAGE_SET_PASSWORD_TTL_SECONDS (7 days), not the reset TTL.
        const second = await newOrder({ packageCode: 'd3', email: newEmail('ttl'), name: 'x' });
        await fakeResult(second.orderId, second.accessToken, 'paid');
        const ttlEmail = (await orderRow(second.orderId))?.email ?? '';
        const ttlToken = linkToken(mailer, ttlEmail, '/reset-password');
        api.clock.advance(6 * DAY);
        const late = await bff('POST', apiPath(AR.photographerPasswordResetConfirm), {
          body: { token: ttlToken, newPassword: SET_PW },
        });
        api.clock.advance(-6 * DAY);
        expect(late.status, JSON.stringify(late.body)).toBe(200);

        // Paying again is a no-op.
        mailer.sent.length = 0;
        const again = await fakeResult(created.orderId, created.accessToken, 'paid');
        expect(again.status).toBe(200);
        expect(mailer.sent).toEqual([]);
        expect(await audits('package.order_paid', created.orderId)).toHaveLength(1);
      });

      it('a signed-in photographer extends a running package and gets "package added"', async () => {
        const me = await freePhotographer();
        const before = await packageRow(me.id);
        await api.db
          .update(photographerPackages)
          .set({ photosUsed: 40 })
          .where(eq(photographerPackages.photographerId, me.id));
        expect(
          await order({ packageCode: 'd3', email: me.email }, { token: me.session.accessToken }),
        ).toMatchObject({
          status: 400,
          body: { details: { issues: [{ path: ['body', 'email'] }] } },
        });

        const created = await newOrder({ packageCode: 'd3' }, me.session.accessToken);
        expect((await orderRow(created.orderId))?.photographerId).toBe(me.id);
        mailer.sent.length = 0;
        const res = await fakeResult(created.orderId, created.accessToken, 'paid');
        const after = await packageRow(me.id);
        // The signed-in owner sees their own new expiry.
        expect(packageOrderViewSchema.parse(res.body)).toMatchObject({
          status: 'paid',
          accountCreated: false,
          expiresAt: after?.expiresAt.toISOString(),
        });
        expect(after?.expiresAt.getTime()).toBe((before?.expiresAt.getTime() ?? 0) + 3 * DAY);
        expect(after?.startsAt.getTime()).toBe(before?.startsAt.getTime());
        expect(after).toMatchObject({ photoLimit: 1100, photosUsed: 40 });
        expect(after?.packageId).toBe(
          (await api.db.select().from(packages).where(eq(packages.code, 'd3')))[0]?.id,
        );
        expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
          [me.email, 'เพิ่มแพ็กเกจแล้ว - Snap'],
        ]);
      });

      it('an expired package gets a fresh period; an anonymous buyer with an account too', async () => {
        const me = await freePhotographer();
        await api.db
          .update(photographerPackages)
          .set({
            startsAt: new Date(api.clock.now().getTime() - 10 * DAY),
            expiresAt: new Date(api.clock.now().getTime() - DAY),
            photosUsed: 100,
          })
          .where(eq(photographerPackages.photographerId, me.id));
        // Anonymous, with the email of an existing photographer who has a package.
        const created = await newOrder({ packageCode: 'd30', email: me.email, name: 'x' });
        const paidView = await fakeResult(created.orderId, created.accessToken, 'paid');
        // An anonymous buyer never sees an existing account's expiry.
        expect(packageOrderViewSchema.parse(paidView.body)).toMatchObject({
          status: 'paid',
          accountCreated: false,
          expiresAt: null,
        });
        const now = api.clock.now().getTime();
        expect(await packageRow(me.id)).toMatchObject({
          photoLimit: 10_000,
          photosUsed: 0,
          startsAt: new Date(now),
          expiresAt: new Date(now + 30 * DAY),
        });
        expect(await orderRow(created.orderId)).toMatchObject({
          photographerId: me.id,
          accountCreated: false,
        });
      });

      it('fake failure marks the order failed; a later payment still counts', async () => {
        const created = await newOrder({ packageCode: 'd3', email: newEmail('fail'), name: 'x' });
        const failed = await fakeResult(created.orderId, created.accessToken, 'failed');
        expect(packageOrderViewSchema.parse(failed.body).status).toBe('failed');
        const paid = await webhook({
          gatewayRef: `fake_${created.orderId}`,
          orderId: created.orderId,
          status: 'paid',
          amountSatang: 42_693,
        });
        expect(paid).toMatchObject({ status: 200, body: { received: true } });
        expect((await orderRow(created.orderId))?.status).toBe('paid');
      });

      it('signed callbacks: amount mismatch applies nothing, duplicates are no-ops', async () => {
        const email = newEmail('mismatch');
        const created = await newOrder({ packageCode: 'd7', email, name: 'x' });
        const base = { gatewayRef: `fake_${created.orderId}`, orderId: created.orderId };
        const wrong = await webhook({ ...base, status: 'paid', amountSatang: 100 });
        expect(wrong.status).toBe(200);
        expect(await orderRow(created.orderId)).toMatchObject({
          status: 'amount_mismatch',
          paidAt: null,
          appliedAt: null,
        });
        expect(await api.db.select().from(users).where(eq(users.email, email))).toEqual([]);
        const [audit] = await audits('package.order_amount_mismatch', created.orderId);
        expect(audit).toMatchObject({ actorId: null });
        expect(audit?.meta).toMatchObject({ totalSatang: 64_093, paidSatang: 100 });

        const ok = await newOrder({ packageCode: 'd7', email: newEmail('dup'), name: 'x' });
        const paid = {
          gatewayRef: `fake_${ok.orderId}`,
          orderId: ok.orderId,
          status: 'paid' as const,
          amountSatang: 64_093,
        };
        expect((await webhook(paid)).status).toBe(200);
        const once = await orderRow(ok.orderId);
        const pkgOnce = await packageRow(once?.photographerId ?? '');
        expect((await webhook(paid)).status).toBe(200);
        expect(await packageRow(once?.photographerId ?? '')).toEqual(pkgOnce);
        expect(await audits('package.order_paid', ok.orderId)).toHaveLength(1);

        expect(await webhook(paid, 'f'.repeat(64))).toMatchObject({
          status: 401,
          body: { code: 'WEBHOOK_SIGNATURE_INVALID' },
        });
        const otherGateway = await api.request('POST', apiPath(R.webhook, { gateway: 'mpay' }), {
          rawBody: '{}',
        });
        expect(otherGateway).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
        const unknown = await webhook({ ...paid, orderId: randomUUID() });
        expect(unknown.status).toBe(200);

        // Concurrent deliveries of one payment: one applies, the other finds it paid.
        const raceEmail = newEmail('race-hook');
        const race = await newOrder({ packageCode: 'd7', email: raceEmail, name: 'x' });
        const racePaid = { ...paid, gatewayRef: `fake_${race.orderId}`, orderId: race.orderId };
        const results = await Promise.all([webhook(racePaid), webhook(racePaid)]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(await audits('package.order_paid', race.orderId)).toHaveLength(1);
        expect(await api.db.select().from(users).where(eq(users.email, raceEmail))).toHaveLength(1);
      });

      it('asks the gateway once pending for a while, at most once per interval', async () => {
        const created = await newOrder({ packageCode: 'd3', email: newEmail('inq'), name: 'x' });
        const ref = `fake_${created.orderId}`;
        const poll = async () =>
          packageOrderViewSchema.parse((await getOrder(created.orderId, created.accessToken)).body);
        gateway.setInquiry(ref, {
          gatewayRef: ref,
          orderId: created.orderId,
          status: 'pending',
          amountSatang: 42_693,
        });
        expect((await poll()).status).toBe('pending');
        api.clock.advance(31_000);
        // Asked now (still pending at the gateway) ...
        expect((await poll()).status).toBe('pending');
        gateway.setInquiry(ref, {
          gatewayRef: ref,
          orderId: created.orderId,
          status: 'paid',
          amountSatang: 42_693,
        });
        // ... not again within PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS (20) ...
        expect((await poll()).status).toBe('pending');
        api.clock.advance(20_000);
        // ... then again.
        const late = await poll();
        await settled();
        expect(late).toMatchObject({ status: 'paid', accountCreated: true });
      });

      it('leaves an order pending when its account cannot take a package', async () => {
        const reasons: string[] = [];
        const before = api.events.entries.length;
        // Anonymous, for a photographer who had a package when ordering and is now unlimited.
        const me = await freePhotographer();
        const anon = await newOrder({ packageCode: 'd3', email: me.email, name: 'x' });
        // Signed in, then the package row went away (e.g. an admin made the account unlimited).
        const other = await freePhotographer();
        const own = await newOrder({ packageCode: 'd3' }, other.session.accessToken);
        // Signed in, then the account was disabled.
        const third = await freePhotographer();
        const disabledOrder = await newOrder({ packageCode: 'd3' }, third.session.accessToken);
        for (const id of [me.id, other.id]) {
          await api.db
            .delete(photographerPackages)
            .where(eq(photographerPackages.photographerId, id));
        }
        await api.db
          .update(users)
          .set({ status: 'disabled', disabledAt: api.clock.now() })
          .where(eq(users.id, third.id));
        for (const o of [anon, own, disabledOrder]) {
          const res = await fakeResult(o.orderId, o.accessToken, 'paid');
          expect(res.status).toBe(200);
          expect(packageOrderViewSchema.parse(res.body).status).toBe('pending');
          expect(await audits('package.order_paid', o.orderId)).toEqual([]);
          reasons.push((await orderRow(o.orderId))?.status ?? '');
        }
        expect(reasons).toEqual(['pending', 'pending', 'pending']);
        // Still unlimited: nothing applied.
        expect(await packageRow(me.id)).toBeUndefined();
        expect(await packageRow(other.id)).toBeUndefined();
        const events = api.events.entries
          .slice(before)
          .filter((e) => e.event === 'package.account_unresolvable');
        expect(events).toHaveLength(3);
      });
    });

    describe('switches', () => {
      it('PACKAGE_SALES=off: sign-up and orders are NOT_FOUND, prices and polling still work', async () => {
        const created = await newOrder({ packageCode: 'd3', email: newEmail('off'), name: 'x' });
        const off = await TestApi.start(database.db, {
          env: { ...ENV, PACKAGE_SALES: 'off' },
          accountMailer: mailer,
          packageGateway: gateway,
        });
        try {
          const call = (method: string, path: string, body?: unknown, headers = {}) =>
            off.request(method, path, {
              ...(body === undefined ? {} : { body }),
              headers: { 'x-shotx-bff-key': bffKeyFor(path, body), ...headers },
            });
          for (const [path, body] of [
            [apiPath(R.signupFree), { email: newEmail('x'), name: 'x' }],
            [apiPath(R.signupFreeConfirm), { token: 'A'.repeat(43), password: PW }],
            [apiPath(R.createOrder), { packageCode: 'd3', email: newEmail('x'), name: 'x' }],
          ] as const) {
            expect(
              await call('POST', path, body, { 'idempotency-key': randomUUID() }),
            ).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
          }
          const list = packagesResponseSchema.parse(
            (await off.request('GET', apiPath(R.list))).body,
          );
          expect(list.sales).toEqual({
            salesEnabled: false,
            featuredCode: 'd7',
            onlinePayment: false,
          });
          const view = await call('GET', apiPath(R.getOrder, { id: created.orderId }), undefined, {
            [ORDER_TOKEN_HEADER]: created.accessToken,
          });
          expect(view.status).toBe(200);
        } finally {
          await off.close();
        }
      });

      it('SIGNUP_EMAILS_PER_DAY caps every sign-up email together, silently', async () => {
        const capped = await TestApi.start(database.db, {
          env: { ...ENV, SIGNUP_EMAILS_PER_DAY: '2' },
          accountMailer: mailer,
          packageGateway: gateway,
        });
        try {
          const emails = [newEmail('cap1'), newEmail('cap2'), newEmail('cap3')];
          for (const email of emails) {
            const path = apiPath(R.signupFree);
            const body = { email, name: 'x' };
            const res = await capped.request('POST', path, {
              body,
              headers: { 'x-shotx-bff-key': bffKeyFor(path, body), 'x-shotx-client-ip': nextIp() },
            });
            expect(res.status).toBe(204);
          }
          await capped.app.get(PackagesService).settled();
          expect(emails.map((e) => mailer.sent.filter((m) => m.to === e).length)).toEqual([
            1, 1, 0,
          ]);
          expect(capped.events.entries.map((e) => e.event)).toContain('package.signup_daily_cap');
        } finally {
          await capped.close();
        }
      });

      it('CAPTCHA_PROVIDER=turnstile: POST /signup/free needs a captcha token', async () => {
        const verifier = new FakeCaptchaVerifier();
        const guarded = await TestApi.start(database.db, {
          env: {
            ...ENV,
            CAPTCHA_PROVIDER: 'turnstile',
            TURNSTILE_SECRET_KEY: '0x4AAAAAAAtest-secret-not-a-cloudflare-test-key',
          },
          accountMailer: mailer,
          packageGateway: gateway,
          captchaVerifier: verifier,
        });
        try {
          const email = newEmail('captcha');
          const send = (captchaToken?: string) => {
            const path = apiPath(R.signupFree);
            const body = {
              email,
              name: 'x',
              ...(captchaToken === undefined ? {} : { captchaToken }),
            };
            return guarded.request('POST', path, {
              body,
              headers: {
                'x-shotx-bff-key': bffKeyFor(path, body),
                'x-shotx-client-ip': '203.0.113.9',
              },
            });
          };
          const challenge = (rejected: string | null) => ({
            status: 429,
            body: {
              code: 'RATE_LIMITED',
              details: {
                retryAfterSeconds: 0,
                captcha: { provider: 'turnstile', action: 'signup_free', rejected },
              },
            },
          });
          expect(await send()).toMatchObject(challenge(null));
          expect(await send('wrong-token')).toMatchObject(challenge('invalid'));
          verifier.valid.add('good-token');
          expect((await send('good-token')).status).toBe(204);
          expect(verifier.calls.at(-1)).toMatchObject({
            action: 'signup_free',
            remoteIp: '203.0.113.9',
          });
          await guarded.app.get(PackagesService).settled();
          expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(1);
          expect(guarded.logger.text()).not.toContain('good-token');
        } finally {
          await guarded.close();
        }
      });

      it('PACKAGE_GATEWAY=off and no account email: PAYMENT_UNAVAILABLE, FEATURE_DISABLED', async () => {
        const off = await TestApi.start(database.db, {
          env: { ...ENV, PACKAGE_GATEWAY: 'off', ACCOUNT_EMAIL_PROVIDER: 'off' },
        });
        try {
          const call = (path: string, body: unknown) =>
            off.request('POST', path, {
              body,
              headers: {
                'x-shotx-bff-key': bffKeyFor(path, body),
                'idempotency-key': randomUUID(),
              },
            });
          expect(
            await call(apiPath(R.createOrder), {
              packageCode: 'd3',
              email: newEmail('g'),
              name: 'x',
            }),
          ).toMatchObject({ status: 409, body: { code: 'PAYMENT_UNAVAILABLE' } });
          expect(
            await call(apiPath(R.signupFree), { email: newEmail('m'), name: 'x' }),
          ).toMatchObject({ status: 404, body: { code: 'FEATURE_DISABLED' } });
          const fake = await call(apiPath(R.fakeResult, { id: randomUUID() }), { result: 'paid' });
          expect(fake).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
          const hook = await off.request('POST', apiPath(R.webhook, { gateway: 'fake' }), {
            rawBody: '{}',
          });
          expect(hook).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
          const list = packagesResponseSchema.parse(
            (await off.request('GET', apiPath(R.list))).body,
          );
          expect(list.sales.onlinePayment).toBe(false);
        } finally {
          await off.close();
        }
      });
    });

    describe('mPAY (ADR 0029)', () => {
      const MPAY_ENV = {
        ...ENV,
        PACKAGE_GATEWAY: 'mpay',
        MPAY_API_URL: 'https://mpay.example.test/prod',
        MPAY_MERCHANT_ID: '5396508',
        MPAY_SECRET_KEY: 'mpay-integration-secret-0123',
        MPAY_SERVICE_ID: '19100061935133847',
        PACKAGE_PAY_RATE_PER_ORDER: '4',
      };
      const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5Mz';
      /** mPAY answers by path, in turn; what Snap sent is kept. */
      const answers = new Map<string, { status?: number; body: unknown }[]>();
      const sent: { path: string; body: Record<string, unknown> }[] = [];
      const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const path = new URL(url).pathname.replace(/^\/prod/, '');
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        sent.push({ path, body: JSON.parse(raw) as Record<string, unknown> });
        const answer = answers.get(path)?.shift() ?? { status: 500, body: {} };
        return Promise.resolve(
          new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 }),
        );
      }) as typeof fetch;
      const answer = (path: string, ...list: { status?: number; body: unknown }[]) =>
        answers.set(path, [...(answers.get(path) ?? []), ...list]);

      let mpayApi: TestApi;
      let mpay: MpayPackageGateway;

      beforeAll(async () => {
        const config = loadPackageGatewayConfig(MPAY_ENV);
        if (config.gateway !== 'mpay') throw new Error('not mpay');
        mpay = new MpayPackageGateway(config.mpay, 'http://localhost:3000', fetchFn, () =>
          mpayApi.clock.now(),
        );
        mpayApi = await TestApi.start(database.db, {
          env: MPAY_ENV,
          accountMailer: mailer,
          packageGateway: mpay,
        });
      }, 120_000);
      afterAll(async () => {
        await mpayApi?.close();
      });

      const call = <T = unknown>(
        method: string,
        path: string,
        body: unknown,
        headers: Record<string, string> = {},
      ) =>
        mpayApi.request<T>(method, path, {
          ...(body === undefined ? {} : { body }),
          headers: {
            'x-shotx-bff-key': bffKeyFor(path, body),
            'x-shotx-client-ip': nextIp(),
            ...headers,
          },
        });
      async function mpayOrder() {
        const res = await call(
          'POST',
          apiPath(R.createOrder),
          {
            packageCode: 'd3',
            email: newEmail('mpay'),
            name: 'ผู้ซื้อ mPAY',
          },
          { 'idempotency-key': randomUUID() },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return createPackageOrderResponseSchema.parse(res.body);
      }
      const pay = (id: string, token: string, method: string) =>
        call('POST', apiPath(R.pay, { id }), { method }, { [ORDER_TOKEN_HEADER]: token });
      const view = async (id: string, token: string) =>
        packageOrderViewSchema.parse(
          (
            await call('GET', apiPath(R.getOrder, { id }), undefined, {
              [ORDER_TOKEN_HEADER]: token,
            })
          ).body,
        );
      const notify = async (body: Record<string, unknown>) => {
        const raw = JSON.stringify(body);
        const nonce = randomUUID();
        const res = await mpayApi.request('POST', apiPath(R.webhook, { gateway: 'mpay' }), {
          rawBody: raw,
          headers: {
            [MPAY_HEADERS.nonce]: nonce,
            [MPAY_HEADERS.merchantId]: '5396508',
            [MPAY_HEADERS.signature]: mpay.sign(raw, nonce),
          },
        });
        await mpayApi.app.get(PackagesService).settled();
        return res;
      };

      it('sends the buyer to the pay page, then a QR or a card form per attempt', async () => {
        const created = await mpayOrder();
        expect(created.redirectUrl).toBe(
          `http://localhost:3000/checkout/pay?order=${created.orderId}`,
        );
        expect(await orderRow(created.orderId)).toMatchObject({
          gateway: 'mpay',
          gatewayRef: null,
          gatewayAttempts: [],
        });
        expect((await view(created.orderId, created.accessToken)).paymentMethods).toEqual([
          'qr',
          'card',
        ]);

        answer(MPAY_PATHS.qr, { body: { txn_id: 'T1', qr_img: PNG } });
        const qr = await pay(created.orderId, created.accessToken, 'qr');
        expect(qr.status, JSON.stringify(qr.body)).toBe(200);
        expect(startPackagePaymentResponseSchema.parse(qr.body)).toEqual({
          method: 'qr',
          qrImage: `data:image/png;base64,${PNG}`,
          expiresAt: new Date(mpayApi.clock.now().getTime() + 600_000).toISOString(),
        });
        const first = sent.at(-1);
        expect(first?.path).toBe(MPAY_PATHS.qr);
        expect(first?.body).toMatchObject({
          amount: 426.93,
          currency: 'THB',
          ref_1: created.orderId,
          service_id: '19100061935133847',
          product_name: 'Snap 3 Days',
          sof: 'PROMPTPAY',
        });

        answer(MPAY_PATHS.card, { body: { form_url: 'https://pay.mpay.example.test/f/1' } });
        const card = await pay(created.orderId, created.accessToken, 'card');
        expect(card.body).toEqual({
          method: 'card',
          redirectUrl: 'https://pay.mpay.example.test/f/1',
        });
        expect(sent.at(-1)?.body).toMatchObject({
          '3ds': { '3ds_url_success': 'http://localhost:3000/checkout/back' },
        });
        const row = await orderRow(created.orderId);
        // Newest first, each its own mPAY order_id.
        expect(row?.gatewayAttempts).toEqual([sent.at(-1)?.body.order_id, first?.body.order_id]);

        // mPAY refusing (a channel not switched on) is PAYMENT_GATEWAY_ERROR, logged by code.
        answer(MPAY_PATHS.qr, { body: { error_code: 'INVALID_REQUEST', error: 'SofId inActive' } });
        expect(await pay(created.orderId, created.accessToken, 'qr')).toMatchObject({
          status: 502,
          body: { code: 'PAYMENT_GATEWAY_ERROR' },
        });
        expect(mpayApi.events.entries.at(-1)).toMatchObject({
          event: 'package.payment_start_failed',
        });
        // PACKAGE_PAY_RATE_PER_ORDER (4 here).
        answer(MPAY_PATHS.qr, { body: { qr_img: PNG } });
        expect((await pay(created.orderId, created.accessToken, 'qr')).status).toBe(200);
        expect(await pay(created.orderId, created.accessToken, 'qr')).toMatchObject({
          status: 429,
          body: { code: 'RATE_LIMITED' },
        });
        expect(await pay(created.orderId, 'B'.repeat(43), 'qr')).toMatchObject({
          status: 404,
          body: { code: 'ORDER_NOT_FOUND' },
        });
      });

      it('a signed Payment Notify settles the order; failures keep it payable', async () => {
        const created = await mpayOrder();
        answer(MPAY_PATHS.qr, { body: { qr_img: PNG } });
        await pay(created.orderId, created.accessToken, 'qr');
        const attempt = sent.at(-1)?.body.order_id;
        const base = {
          order_id: attempt,
          txn_type: 'PAYMENT',
          status_code: 'SR0000',
          amount: 426.93,
          amount_net: 426.93,
          amount_cust_fee: 0,
          currency: 'THB',
          ref_1: created.orderId,
          sof_type: 'SOF_PROMPTPAY',
        };
        const failed = await notify({ ...base, txn_id: 'TFAIL1', status: 'FAIL' });
        expect(failed.status).toBe(200);
        expect(await orderRow(created.orderId)).toMatchObject({
          status: 'pending',
          gatewayRef: null,
        });

        // A forged notify (wrong signature) is refused before anything is read.
        const forged = await mpayApi.request('POST', apiPath(R.webhook, { gateway: 'mpay' }), {
          rawBody: JSON.stringify({ ...base, txn_id: 'TX', status: 'SUCCESS' }),
          headers: { [MPAY_HEADERS.nonce]: 'n', [MPAY_HEADERS.signature]: '0'.repeat(64) },
        });
        expect(forged).toMatchObject({ status: 401, body: { code: 'WEBHOOK_SIGNATURE_INVALID' } });

        const paid = await notify({ ...base, txn_id: 'TPAID1', status: 'SUCCESS' });
        expect(paid.status).toBe(200);
        expect(await orderRow(created.orderId)).toMatchObject({
          status: 'paid',
          gatewayRef: 'TPAID1',
          accountCreated: true,
        });
        expect((await view(created.orderId, created.accessToken)).paymentMethods).toEqual([]);
        expect(await pay(created.orderId, created.accessToken, 'qr')).toMatchObject({
          status: 409,
          body: { code: 'PAYMENT_UNAVAILABLE' },
        });
        // mPAY sends again: a duplicate, still 200.
        expect((await notify({ ...base, txn_id: 'TPAID1', status: 'SUCCESS' })).status).toBe(200);
        expect(await audits('package.order_paid', created.orderId)).toHaveLength(1);
      });

      it('asks mPAY about the attempts when the notify is late', async () => {
        const created = await mpayOrder();
        answer(MPAY_PATHS.qr, { body: { qr_img: PNG } }, { body: { qr_img: PNG } });
        await pay(created.orderId, created.accessToken, 'qr');
        await pay(created.orderId, created.accessToken, 'qr');
        const [newest, older] = (await orderRow(created.orderId))?.gatewayAttempts ?? [];
        mpayApi.clock.advance(31_000);
        answer(
          MPAY_PATHS.enquiry,
          { status: 400, body: { error_code: 'TXN_NOT_FOUND' } },
          {
            body: {
              order_id: older,
              txn_id: 'TENQ1',
              txn_type: 'PAYMENT',
              status: 'SUCCESS',
              amount: 426.93,
              currency: 'THB',
              ref_1: created.orderId,
            },
          },
        );
        const polled = await view(created.orderId, created.accessToken);
        await mpayApi.app.get(PackagesService).settled();
        expect(polled.status).toBe('paid');
        expect(sent.slice(-2).map((r) => r.body)).toEqual([
          { order_id: newest },
          { order_id: older },
        ]);
        expect(await orderRow(created.orderId)).toMatchObject({ gatewayRef: 'TENQ1' });
      });
    });

    it('never logs emails, tokens or passwords', () => {
      const text = api.logger.text();
      expect(text).not.toContain('@example.test');
      expect(text).not.toContain(PW);
      expect(text).not.toContain('#token=');
      for (const event of api.events.entries) {
        expect(JSON.stringify(event)).not.toContain('@example.test');
      }
    });
  });
}
