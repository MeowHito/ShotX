import { randomUUID } from 'node:crypto';
import {
  adminCredentials,
  auditLog,
  authSessions,
  cashPayments,
  files,
  storageUsage,
  userPasswordCredentials,
  users,
} from '@shotx/db';
import {
  ADMIN_ROUTES as A,
  actAsResponseSchema,
  adminSystemResponseSchema,
  adminUserSchema,
  apiPath,
  AUTH_ROUTES as AR,
  authTokenResponseSchema,
  type AuthTokenResponse,
  BILLING_ROUTES as B,
  cashPaymentSchema,
  DRIVE_ROUTES,
  driveUsageResponseSchema,
  listAdminUsersResponseSchema,
  listCashPaymentsResponseSchema,
  ME_ROUTES,
  meResponseSchema,
  PASSWORD_CHANGE_CLAIM,
  PHOTOGRAPHER_ACCOUNT_ROUTES as P,
  photographerSignInResponseSchema,
  SHARE_ROUTES,
  UPLOAD_ROUTES,
} from '@shotx/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, totpStep } from '../auth/totp';
import { startSession } from '../auth/sessions';
import { ShotxTokenIssuer } from '../auth/shotx-tokens';
import type { AdminOpsContext } from '../cli/admin-ops';
import { challengeStep, changePasswordChallenge, createTotpAdmin } from '../testing/admins';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { insertReadyFile } from '../testing/seed';
import { OFFLINE_ACCOUNTS_ENV } from '../testing/fakes';
import { TestApi, type TestResponse } from '../testing/harness';
import { bffKeyFor, shotxEnv, TEST_ADMIN_BFF_KEY, TEST_BFF_KEY } from '../testing/shotx-auth';
import { AdminUsersService } from './admin-users.service';

// ADR 0010 end to end: admin-provisioned accounts, photographer email + password with the forced
// first change, disabling, the admin step model (change password, enrol TOTP), cash payments,
// and billing/quota switched off. Every email is @example.test; every password is a made-up test
// value.

const ADMIN_PW = 'fake-Admin-pw-4821';
const TEMP_PW = 'fake-Temp-pw-7305';
const NEW_PW = 'fake-Fresh-pw-9164';
const MiB = 1024 * 1024;

let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;
let emailCounter = 0;
const email = (label: string) => `${label}-${emailCounter++}@example.test`;

const ENV = shotxEnv({
  ...OFFLINE_ACCOUNTS_ENV,
  // These suites use the TOTP flow; ADMIN_MFA_MODE=off has its own tests.
  ADMIN_MFA_MODE: 'totp',
  PHOTOGRAPHER_LOGIN_LOCKOUT_THRESHOLD: '3',
  PHOTOGRAPHER_LOGIN_RATE_PER_ACCOUNT: '20',
  PHOTOGRAPHER_LOGIN_RATE_PER_IP: '6',
  PHOTOGRAPHER_PASSWORD_CHANGE_SESSION_TTL_SECONDS: '1200',
});

/** Shared helpers over one running API. */
function helpers(get: () => TestApi) {
  const api = () => get();
  const bff = <T = unknown>(path: string, body: unknown, ip = nextIp()) =>
    api().request<T>('POST', path, {
      body,
      headers: { 'x-shotx-bff-key': bffKeyFor(path, body), 'x-shotx-client-ip': ip },
    });
  const ops = (): AdminOpsContext => {
    const admin = api().config.shotxAuth?.admin;
    if (admin === undefined || admin === null) throw new Error('admin sign-in is off');
    return {
      db: api().db,
      stage: api().config.app.stage,
      admin,
      argon2id: api().config.password.argon2id,
      now: () => api().clock.now(),
      operator: 'test-operator',
    };
  };
  const totp = (secretBase32: string) =>
    hotp(base32Decode(secretBase32), totpStep(api().clock.now().getTime(), 30), 6);
  const secretOf = (otpauthUri: string) => new URL(otpauthUri).searchParams.get('secret') ?? '';

  /** Password + code of an admin whose TOTP is set (a fresh time step each time). */
  async function adminSignIn(address: string, password: string, secret: string) {
    api().clock.advance(31_000);
    const login = await bff(apiPath(AR.adminLogin), { email: address, password });
    expect(login.status).toBe(200);
    const step = challengeStep(login.body);
    expect(step.step).toBe('totp');
    const mfa = await bff(apiPath(AR.adminMfa), {
      challengeId: step.challengeId,
      code: totp(secret),
    });
    expect(mfa.status).toBe(200);
    return authTokenResponseSchema.parse(mfa.body);
  }

  /** An admin made by the operator CLI (must_change_password false), signed in. */
  async function cliAdmin(label = 'ops') {
    const address = email(label);
    const enrolment = await createTotpAdmin(ops(), {
      email: address,
      name: label,
      password: ADMIN_PW,
    });
    const tokens = await adminSignIn(address, ADMIN_PW, enrolment.secretBase32);
    return {
      id: enrolment.userId,
      email: address,
      secret: enrolment.secretBase32,
      token: tokens.accessToken,
    };
  }

  const admin = <T = unknown>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<TestResponse<T>> =>
    api().request<T>(method, path, {
      token,
      ...(body === undefined ? {} : { body }),
      // The admin app's BFF sends its key on every admin route (BffKeyGuard).
      headers: { 'x-shotx-bff-key': TEST_ADMIN_BFF_KEY, ...headers },
    });

  /** POST /admin/users for a photographer with TEMP_PW. */
  async function createPhotographer(adminToken: string, label = 'studio') {
    const res = await admin(adminToken, 'POST', apiPath(A.createUser), {
      email: email(label),
      name: `Studio ${label}`,
      role: 'photographer',
      password: TEMP_PW,
    });
    expect(res.status).toBe(201);
    return adminUserSchema.parse(res.body);
  }

  const signIn = (address: string, password: string, ip?: string) =>
    bff(apiPath(AR.photographerSignIn), { email: address, password }, ip);

  const changePassword = (token: string, currentPassword: string, newPassword: string) =>
    api().request('POST', apiPath(P.changePassword), {
      token,
      body: { currentPassword, newPassword },
    });

  /** A photographer that signed in and changed the temporary password: a normal session. */
  async function activePhotographer(adminToken: string, label = 'active') {
    const created = await createPhotographer(adminToken, label);
    const first = photographerSignInResponseSchema.parse(
      (await signIn(created.email ?? '', TEMP_PW)).body,
    );
    const changed = await changePassword(first.accessToken, TEMP_PW, NEW_PW);
    expect(changed.status).toBe(200);
    return { ...created, tokens: authTokenResponseSchema.parse(changed.body) };
  }

  const audits = (action: string, targetId?: string) =>
    api()
      .db.select()
      .from(auditLog)
      .where(
        targetId === undefined
          ? eq(auditLog.action, action)
          : and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)),
      );

  return {
    bff,
    ops,
    totp,
    secretOf,
    adminSignIn,
    cliAdmin,
    admin,
    createPhotographer,
    signIn,
    changePassword,
    activePhotographer,
    audits,
  };
}

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`ADR 0010 accounts on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    const h = helpers(() => api);
    let boss: Awaited<ReturnType<typeof h.cliAdmin>>;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, { env: ENV });
      boss = await h.cliAdmin('boss');
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    describe('only admins create accounts', () => {
      it('refuses users-pool tokens and anonymous calls on every /admin route', async () => {
        const photographer = await h.activePhotographer(boss.token, 'not-admin');
        const body = { email: email('x'), name: 'X', role: 'admin', password: TEMP_PW };
        for (const token of [photographer.tokens.accessToken, undefined]) {
          const res = await api.request('POST', apiPath(A.createUser), { token, body });
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
          const list = await api.request('GET', apiPath(A.listUsers), { token });
          expect(list.status).toBe(401);
        }
        // A valid admin token is refused without the admin app's BFF key, or with a wrong one.
        for (const key of [undefined, 'wrong-key-0123456789abcdef0123456789', TEST_BFF_KEY]) {
          const res = await api.request('GET', apiPath(A.listUsers), {
            token: boss.token,
            ...(key === undefined ? {} : { headers: { 'x-shotx-bff-key': key } }),
          });
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        }
        expect((await h.admin(boss.token, 'GET', apiPath(A.listUsers))).status).toBe(200);
        // Self-serve onboarding is gone.
        const me = await api.request('POST', apiPath(ME_ROUTES.becomePhotographer), {
          token: photographer.tokens.accessToken,
          body: {},
        });
        expect(me.body).toMatchObject({ code: 'FORBIDDEN' });
      });

      it('creates a photographer: password: subject, temporary password, usage row, audit', async () => {
        const created = await h.createPhotographer(boss.token, 'create');
        expect(created).toMatchObject({
          role: 'photographer',
          status: 'active',
          passwordAccount: true,
          mustChangePassword: true,
          createdById: boss.id,
          lastSignInAt: null,
          usedBytes: 0,
          totpEnrolled: null,
          lockedUntil: null,
          disabledAt: null,
        });
        expect(JSON.stringify(created)).not.toContain(TEMP_PW);
        const [row] = await api.db.select().from(users).where(eq(users.id, created.id));
        expect(row).toMatchObject({
          authPool: 'users',
          authSubject: `password:${created.id}`,
          createdById: boss.id,
        });
        const [cred] = await api.db
          .select()
          .from(userPasswordCredentials)
          .where(eq(userPasswordCredentials.userId, created.id));
        expect(cred?.passwordHash).toMatch(/^\$argon2id\$/);
        expect(cred?.mustChangePassword).toBe(true);
        expect(
          await api.db
            .select()
            .from(storageUsage)
            .where(eq(storageUsage.photographerId, created.id)),
        ).toHaveLength(1);
        const [audit] = await h.audits('admin.user.created', created.id);
        expect(audit).toMatchObject({
          actorId: boss.id,
          targetType: 'user',
          meta: { role: 'photographer', email: created.email },
        });
        // The password is never logged or audited.
        expect(api.logger.text()).not.toContain(TEMP_PW);
        expect(JSON.stringify(await api.db.select().from(auditLog))).not.toContain(TEMP_PW);
      });

      it('creates an admin in the admins pool without TOTP and a temporary password', async () => {
        const res = await h.admin(boss.token, 'POST', apiPath(A.createUser), {
          email: email('second-admin'),
          name: 'Second',
          role: 'admin',
          password: ADMIN_PW,
        });
        expect(res.status).toBe(201);
        const created = adminUserSchema.parse(res.body);
        expect(created).toMatchObject({
          role: 'admin',
          usedBytes: null,
          mustChangePassword: true,
          totpEnrolled: false,
        });
        const [row] = await api.db.select().from(users).where(eq(users.id, created.id));
        expect(row).toMatchObject({ authPool: 'admins', authSubject: `admin:${created.id}` });
        const [cred] = await api.db
          .select()
          .from(adminCredentials)
          .where(eq(adminCredentials.userId, created.id));
        expect(cred).toMatchObject({
          mustChangePassword: true,
          totpSecretEncrypted: null,
          totpSecretNonce: null,
          totpConfirmedAt: null,
        });
      });

      it('answers EMAIL_TAKEN ignoring ASCII case, across both pools', async () => {
        const address = email('Taken');
        const first = await h.admin(boss.token, 'POST', apiPath(A.createUser), {
          email: address,
          name: 'One',
          role: 'photographer',
          password: TEMP_PW,
        });
        expect(first.status).toBe(201);
        for (const [variant, role] of [
          [address.toUpperCase(), 'photographer'],
          [`  ${address.toLowerCase()} `, 'photographer'],
          [address.toUpperCase(), 'admin'],
        ] as const) {
          const again = await h.admin(boss.token, 'POST', apiPath(A.createUser), {
            email: variant,
            name: 'Two',
            role,
            password: role === 'admin' ? ADMIN_PW : TEMP_PW,
          });
          expect(again.status, variant).toBe(409);
          expect(again.body).toMatchObject({ code: 'EMAIL_TAKEN' });
        }
        // The CLI too.
        await expect(
          createTotpAdmin(h.ops(), {
            email: address.toUpperCase(),
            name: 'Cli',
            password: ADMIN_PW,
          }),
        ).rejects.toThrow(/already exists/);
      });

      it('takes any temporary password from TEMPORARY_PASSWORD_MIN_LENGTH up (ADR 0015)', async () => {
        for (const [role, password] of [
          ['photographer', '123'],
          ['admin', 'abc'],
        ] as const) {
          const address = email('short');
          const res = await h.admin(boss.token, 'POST', apiPath(A.createUser), {
            email: address,
            name: 'Policy',
            role,
            password,
          });
          expect(res.status, password).toBe(422);
          expect(res.body).toMatchObject({
            code: 'PASSWORD_TOO_WEAK',
            details: { reason: 'too_short', minLength: 4 },
          });
          expect(await api.db.select().from(users).where(eq(users.email, address))).toHaveLength(0);
        }
        // Simple, common or containing the email: fine for a temporary password.
        for (const [role, password] of [
          ['photographer', '1111'],
          ['photographer', 'Password1234'],
          ['admin', '1234'],
        ] as const) {
          const address = email('simple');
          const res = await h.admin(boss.token, 'POST', apiPath(A.createUser), {
            email: address,
            name: 'Simple',
            role,
            password,
          });
          expect(res.status, password).toBe(201);
        }
      });

      it('reports the system overview: storage, the bucket and the server (ADR 0016)', async () => {
        const p = await h.createPhotographer(boss.token, 'overview');
        await insertReadyFile(api.db, p.id, { name: 'a.jpg', sizeBytes: 2000 });
        api.storage.objects.set(`originals/${p.id}/x/a.jpg`, {
          size: 2000,
          contentType: 'image/jpeg',
        });
        api.storage.objects.set(`derived/${p.id}/x/thumb.webp`, {
          size: 300,
          contentType: 'image/webp',
        });
        const scansBefore = api.storage.bucketScans;
        const res = await h.admin(boss.token, 'GET', apiPath(A.system));
        expect(res.status).toBe(200);
        const body = adminSystemResponseSchema.parse(res.body);
        expect(body.storage.photoCount).toBeGreaterThanOrEqual(1);
        expect(body.storage.originalsBytes).toBeGreaterThanOrEqual(2000);
        expect(body.bucket).toMatchObject({ name: 'fake-media' });
        expect(body.bucket?.prefixes).toEqual(
          expect.arrayContaining([expect.objectContaining({ prefix: 'derived/' })]),
        );
        expect(body.server.cpuCount).toBeGreaterThan(0);
        expect(body.server.memory.totalBytes).toBeGreaterThan(0);
        // The bucket count is reused until ADMIN_STORAGE_SCAN_TTL_SECONDS passes.
        await h.admin(boss.token, 'GET', apiPath(A.system));
        expect(api.storage.bucketScans - scansBefore).toBeLessThanOrEqual(1);
        // Photographers can't read it.
        const photographer = await api.photographer();
        const refused = await api.request('GET', apiPath(A.system), { token: photographer.token });
        expect(refused.status).not.toBe(200);
      });

      it("counts each photographer's uploaded photos: images, not trashed, not failed", async () => {
        const p = await h.createPhotographer(boss.token, 'photos');
        for (const values of [
          { name: 'a.jpg' },
          { name: 'b.jpg', status: 'processing' as const },
          { name: 'c.webp', mime: 'image/webp' },
          { name: 'clip.mp4', mime: 'video/mp4' },
          { name: 'old.jpg', deletedAt: new Date() },
          { name: 'bad.jpg', status: 'failed' as const },
          { name: 'half.jpg', status: 'uploading' as const },
        ]) {
          await insertReadyFile(api.db, p.id, values);
        }
        const got = adminUserSchema.parse(
          (await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: p.id }))).body,
        );
        expect(got.photoCount).toBe(3);
        const list = listAdminUsersResponseSchema.parse(
          (await h.admin(boss.token, 'GET', `${apiPath(A.listUsers)}?limit=200`)).body,
        );
        expect(list.items.find((u) => u.id === p.id)?.photoCount).toBe(3);
        expect(list.items.find((u) => u.id === boss.id)?.photoCount).toBeNull();
      });

      it('lists and gets accounts (never viewers), with filters and cursor pages', async () => {
        const viewer = await api.viewer();
        const a = await h.createPhotographer(boss.token, 'listme');
        const b = await h.createPhotographer(boss.token, 'listme');
        const c = await h.createPhotographer(boss.token, 'listme');
        const list = (query: string) =>
          h.admin(boss.token, 'GET', `${apiPath(A.listUsers)}${query}`);
        const page1 = listAdminUsersResponseSchema.parse(
          (await list('?q=LISTME&limit=2&role=photographer')).body,
        );
        expect(page1.items.map((u) => u.id)).toEqual([c.id, b.id]);
        expect(page1.nextCursor).not.toBeNull();
        const page2 = listAdminUsersResponseSchema.parse(
          (
            await list(
              `?q=LISTME&limit=2&role=photographer&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
            )
          ).body,
        );
        expect(page2.items.map((u) => u.id)).toEqual([a.id]);
        expect(page2.nextCursor).toBeNull();
        const all = listAdminUsersResponseSchema.parse((await list('?limit=200')).body);
        expect(all.items.some((u) => u.id === viewer.id)).toBe(false);
        expect(all.items.find((u) => u.id === boss.id)).toMatchObject({
          role: 'admin',
          usedBytes: null,
          passwordAccount: true,
          mustChangePassword: false,
          totpEnrolled: true,
        });
        // LIKE wildcards are literal.
        expect(listAdminUsersResponseSchema.parse((await list('?q=%25')).body).items).toEqual([]);
        expect((await list('?cursor=not-a-cursor')).body).toMatchObject({
          code: 'VALIDATION_FAILED',
        });
        expect((await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: a.id }))).body).toEqual(
          a,
        );
        // A Cognito admin (raw subject, no admin_credentials): no password, TOTP unknown here.
        const [cognitoAdmin] = await api.db
          .insert(users)
          .values({ authPool: 'admins', authSubject: randomUUID(), role: 'admin' })
          .returning();
        expect(
          adminUserSchema.parse(
            (await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: cognitoAdmin?.id ?? '' })))
              .body,
          ),
        ).toMatchObject({ role: 'admin', passwordAccount: false, totpEnrolled: null });
        const notAccount = await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: viewer.id }));
        expect(notAccount.status).toBe(404);
        expect(
          (
            await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: viewer.id }), {
              status: 'disabled',
            })
          ).status,
        ).toBe(404);
      });
    });

    describe('photographer sign-in and the forced password change', () => {
      it('restricts the first session to /me and the password change', async () => {
        const created = await h.createPhotographer(boss.token, 'first');
        const res = await h.signIn(created.email ?? '', TEMP_PW);
        expect(res.status).toBe(200);
        const first = photographerSignInResponseSchema.parse(res.body);
        expect(first.step).toBe('change_password');
        expect(first.refreshExpiresIn).toBe(1200);
        const claims = decodeJwt(first.accessToken);
        expect(claims).toMatchObject({
          sub: `password:${created.id}`,
          amr: ['pwd'],
          idp: 'password',
          [PASSWORD_CHANGE_CLAIM]: true,
        });
        const token = first.accessToken;

        const me = await api.request('GET', apiPath(ME_ROUTES.get), { token });
        expect(me.status).toBe(200);
        expect(meResponseSchema.parse(me.body)).toMatchObject({
          role: 'photographer',
          passwordChangeRequired: true,
        });
        for (const [method, path] of [
          ['GET', apiPath(DRIVE_ROUTES.usage)],
          ['GET', apiPath(DRIVE_ROUTES.getFile, { id: created.id })],
          ['POST', apiPath(ME_ROUTES.createViewerSession)],
          ['GET', apiPath(SHARE_ROUTES.list)],
        ] as const) {
          const blocked = await api.request(method, path, { token });
          expect(blocked.status, path).toBe(403);
          expect(blocked.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
        }

        // A refresh keeps the session restricted while the password is temporary.
        const refreshed = await h.bff<AuthTokenResponse>(apiPath(AR.refresh), {
          refreshToken: first.refreshToken,
          pool: 'users',
        });
        expect(refreshed.status).toBe(200);
        expect(decodeJwt(refreshed.body.accessToken)[PASSWORD_CHANGE_CLAIM]).toBe(true);

        // Wrong current password, then the policy.
        const wrong = await h.changePassword(token, 'fake-Wrong-pw-000', NEW_PW);
        expect(wrong.status).toBe(403);
        expect(wrong.body).toMatchObject({ code: 'PASSWORD_INCORRECT' });
        const same = await h.changePassword(token, TEMP_PW, TEMP_PW);
        expect(same.body).toMatchObject({
          code: 'PASSWORD_TOO_WEAK',
          details: { reason: 'same_as_current' },
        });

        // A restricted bearer is refused on the public share routes too.
        const sharer = await h.activePhotographer(boss.token, 'sharer');
        const folder = await api.folder(sharer.id, { name: 'Public' });
        const share = await api.share(sharer.id, { folderId: folder.id });
        const publicPage = await api.request('GET', `/api/s/${share.token}`, { token });
        expect(publicPage.status).toBe(403);
        expect(publicPage.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });

        const changed = await h.changePassword(token, TEMP_PW, NEW_PW);
        expect(changed.status).toBe(200);
        const tokens = authTokenResponseSchema.parse(changed.body);
        // The old (unexpired) access token ends at once with its session.
        const oldMe = await api.request('GET', apiPath(ME_ROUTES.get), { token });
        expect(oldMe.status).toBe(401);
        expect(oldMe.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        expect(decodeJwt(tokens.accessToken)[PASSWORD_CHANGE_CLAIM]).toBeUndefined();
        expect(tokens.refreshExpiresIn).toBe(
          api.config.shotxAuth?.pools.users.refreshTokenTtlSeconds,
        );
        // Every earlier session is revoked; the new one works everywhere.
        const old = await h.bff(apiPath(AR.refresh), {
          refreshToken: refreshed.body.refreshToken,
          pool: 'users',
        });
        expect(old.body).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
        const usage = await api.request('GET', apiPath(DRIVE_ROUTES.usage), {
          token: tokens.accessToken,
        });
        expect(usage.status).toBe(200);
        const [cred] = await api.db
          .select()
          .from(userPasswordCredentials)
          .where(eq(userPasswordCredentials.userId, created.id));
        expect(cred).toMatchObject({ mustChangePassword: false, failedAttempts: 0 });
        expect(cred?.passwordChangedAt).not.toBeNull();
        expect(await h.audits('auth.photographer.password_changed', created.id)).toHaveLength(1);

        // The next sign-in is a normal session; the temporary password no longer works.
        const again = photographerSignInResponseSchema.parse(
          (await h.signIn(created.email ?? '', NEW_PW)).body,
        );
        expect(again.step).toBe('signed_in');
        expect(decodeJwt(again.accessToken)[PASSWORD_CHANGE_CLAIM]).toBeUndefined();
        expect((await h.signIn(created.email ?? '', TEMP_PW)).body).toMatchObject({
          code: 'INVALID_CREDENTIALS',
        });
        const listed = adminUserSchema.parse(
          (await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: created.id }))).body,
        );
        expect(listed.mustChangePassword).toBe(false);
        expect(listed.lastSignInAt).toBe(api.clock.now().toISOString());
        expect(api.logger.text()).not.toContain(NEW_PW);
      });

      it('answers unknown emails, wrong passwords and LINE photographers alike', async () => {
        const created = await h.activePhotographer(boss.token, 'alike');
        const line = await api.db
          .insert(users)
          .values({
            authPool: 'users',
            authSubject: 'line:U-line-photographer',
            role: 'photographer',
            email: email('line'),
          })
          .returning();
        for (const [address, password] of [
          [email('nobody'), NEW_PW],
          [created.email ?? '', 'fake-Wrong-pw-111'],
          [line[0]?.email ?? '', NEW_PW],
        ] as const) {
          const res = await h.signIn(address, password);
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
        }
        const failed = await h.audits('auth.photographer.sign_in_failed');
        expect(
          failed.some((r) => r.actorId === null && r.targetType === 'photographer_login'),
        ).toBe(true);
        expect(failed.some((r) => r.actorId === created.id)).toBe(true);
        expect(JSON.stringify(failed)).not.toContain('nobody');
      });

      it('locks an account after the threshold (RATE_LIMITED), and a reset unlocks it', async () => {
        const created = await h.activePhotographer(boss.token, 'lock');
        const address = created.email ?? '';
        for (let i = 0; i < 3; i++) {
          expect((await h.signIn(address, 'fake-Wrong-pw-222')).body).toMatchObject({
            code: 'INVALID_CREDENTIALS',
          });
        }
        const locked = await h.signIn(address, NEW_PW);
        expect(locked.status).toBe(429);
        // A lockout only blocks new sign-ins: the open studio session keeps working (no DoS by
        // guessing passwords for someone else's email), refresh included.
        expect(
          (
            await api.request('GET', apiPath(DRIVE_ROUTES.usage), {
              token: created.tokens.accessToken,
            })
          ).status,
        ).toBe(200);
        const stillRefreshes = await h.bff(apiPath(AR.refresh), {
          refreshToken: created.tokens.refreshToken,
          pool: 'users',
        });
        expect(stillRefreshes.status).toBe(200);
        expect((await h.signIn(address, NEW_PW)).status).toBe(429);
        expect(locked.body).toMatchObject({ code: 'RATE_LIMITED' });
        expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(await h.audits('auth.photographer.locked', created.id)).toHaveLength(1);
        const listed = adminUserSchema.parse(
          (await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: created.id }))).body,
        );
        expect(listed.lockedUntil).not.toBeNull();
        // Unknown emails lock the same way.
        const ghost = email('ghost');
        for (let i = 0; i < 3; i++) await h.signIn(ghost, 'fake-Wrong-pw-333');
        expect((await h.signIn(ghost, 'fake-Wrong-pw-333')).status).toBe(429);

        const reset = await h.admin(
          boss.token,
          'POST',
          apiPath(A.resetPassword, { id: created.id }),
          { password: TEMP_PW },
        );
        expect(reset.status).toBe(200);
        expect(adminUserSchema.parse(reset.body)).toMatchObject({
          lockedUntil: null,
          mustChangePassword: true,
        });
        const after = photographerSignInResponseSchema.parse(
          (await h.signIn(address, TEMP_PW)).body,
        );
        expect(after.step).toBe('change_password');
      });

      it('rate-limits sign-in attempts per client IP', async () => {
        const ip = '198.18.0.9';
        const statuses: number[] = [];
        for (let i = 0; i < 7; i++) {
          statuses.push((await h.signIn(email('ip'), 'fake-Wrong-pw-444', ip)).status);
        }
        expect(statuses.slice(0, 6).every((s) => s === 401)).toBe(true);
        expect(statuses[6]).toBe(429);
      });

      it('keeps LINE/Google photographers working (no password, FORBIDDEN on the change)', async () => {
        const [row] = await api.db
          .insert(users)
          .values({ authPool: 'users', authSubject: 'google:legacy-1', role: 'photographer' })
          .returning();
        const auth = api.config.shotxAuth;
        if (auth === null || row === undefined) throw new Error('shotx auth is off');
        const issuer = new ShotxTokenIssuer(api.config.app.stage, auth, api.clock);
        const session = await startSession(api.db, {
          userId: row.id,
          pool: 'users',
          now: api.clock.now(),
          ttlSeconds: 3600,
          amr: ['fed'],
        });
        const { token } = await issuer.accessToken('users', {
          subject: 'google:legacy-1',
          sessionId: session.familyId,
          amr: ['fed'],
        });
        // A token without a live session is refused (assertUserSessionLive).
        const orphan = await issuer.accessToken('users', {
          subject: 'google:legacy-1',
          sessionId: row.id,
          amr: ['fed'],
        });
        expect(
          (await api.request('GET', apiPath(DRIVE_ROUTES.usage), { token: orphan.token })).body,
        ).toMatchObject({ code: 'UNAUTHENTICATED' });
        expect((await api.request('GET', apiPath(DRIVE_ROUTES.usage), { token })).status).toBe(200);
        const change = await h.changePassword(token, 'fake-Any-pw-555', NEW_PW);
        expect(change.body).toMatchObject({ code: 'FORBIDDEN' });
        const listed = adminUserSchema.parse(
          (await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: row.id }))).body,
        );
        expect(listed).toMatchObject({ passwordAccount: false, mustChangePassword: false });
        const reset = await h.admin(boss.token, 'POST', apiPath(A.resetPassword, { id: row.id }), {
          password: TEMP_PW,
        });
        expect(reset.body).toMatchObject({ code: 'CONFLICT' });
      });
    });

    describe('BFF key scopes (web key vs admin key)', () => {
      const withKey = (path: string, key: string, body?: unknown, token?: string) =>
        api.request('POST', path, {
          ...(token === undefined ? {} : { token }),
          ...(body === undefined ? {} : { body }),
          headers: { 'x-shotx-bff-key': key, 'x-shotx-client-ip': nextIp() },
        });

      it("refuses web's key on admin routes and admin sign-in", async () => {
        const list = await api.request('GET', apiPath(A.listUsers), {
          token: boss.token,
          headers: { 'x-shotx-bff-key': TEST_BFF_KEY },
        });
        expect(list.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        for (const [path, body] of [
          [apiPath(AR.adminLogin), { email: boss.email, password: ADMIN_PW }],
          [apiPath(AR.adminChangePassword), { challengeId: 'x'.repeat(43), newPassword: NEW_PW }],
          [apiPath(AR.adminMfa), { challengeId: 'x'.repeat(43), code: '123456' }],
        ] as const) {
          const res = await withKey(path, TEST_BFF_KEY, body);
          expect(res.status, path).toBe(401);
          expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        }
      });

      it("refuses the admin key on web's sign-in routes", async () => {
        const p = await h.activePhotographer(boss.token, 'keys');
        const signIn = await withKey(apiPath(AR.photographerSignIn), TEST_ADMIN_BFF_KEY, {
          email: p.email,
          password: NEW_PW,
        });
        expect(signIn.status).toBe(401);
        expect(signIn.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        const oidc = await withKey(
          apiPath(AR.oidcStart, { provider: 'google' }),
          TEST_ADMIN_BFF_KEY,
          { redirectUri: 'http://localhost:3000/auth/callback' },
        );
        expect(oidc.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        // Either key may read the providers.
        for (const key of [TEST_BFF_KEY, TEST_ADMIN_BFF_KEY]) {
          const res = await api.request('GET', apiPath(AR.providers), {
            headers: { 'x-shotx-bff-key': key },
          });
          expect(res.status).toBe(200);
        }
      });

      it('refresh: the key must match the body pool; logout: the session pool', async () => {
        const p = await h.activePhotographer(boss.token, 'keys-refresh');
        const usersBody = { refreshToken: p.tokens.refreshToken, pool: 'users' };
        const mismatch = await withKey(apiPath(AR.refresh), TEST_ADMIN_BFF_KEY, usersBody);
        expect(mismatch.status).toBe(401);
        expect(mismatch.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        const adminsBody = { refreshToken: p.tokens.refreshToken, pool: 'admins' };
        expect((await withKey(apiPath(AR.refresh), TEST_BFF_KEY, adminsBody)).status).toBe(401);
        // The refused calls rotated nothing: the token still refreshes with the right key.
        const ok = await withKey(apiPath(AR.refresh), TEST_BFF_KEY, usersBody);
        expect(ok.status).toBe(200);
        const rotated = authTokenResponseSchema.parse(ok.body);

        // Logout with the other app's key: 204 and nothing revoked.
        const logout = await withKey(apiPath(AR.logout), TEST_ADMIN_BFF_KEY, {
          refreshToken: rotated.refreshToken,
        });
        expect(logout.status).toBe(204);
        expect(
          await api.db
            .select()
            .from(authSessions)
            .where(and(eq(authSessions.userId, p.id), isNull(authSessions.revokedAt))),
        ).toHaveLength(1);
        expect(
          (
            await withKey(apiPath(AR.refresh), TEST_BFF_KEY, {
              ...usersBody,
              refreshToken: rotated.refreshToken,
            })
          ).status,
        ).toBe(200);
      });
    });

    describe('disable, enable, reset', () => {
      it('disables a photographer: sessions revoked, sign-in blocked, shares offline, files kept', async () => {
        const p = await h.activePhotographer(boss.token, 'disable');
        const folder = await api.folder(p.id, { name: 'Event' });
        const file = await api.file(p.id, folder.id);
        const share = await api.share(p.id, { folderId: folder.id });
        const browser = api.browser();
        expect((await browser.request('GET', `/api/s/${share.token}`)).status).toBe(200);

        const res = await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: p.id }), {
          status: 'disabled',
        });
        expect(res.status).toBe(200);
        const disabled = adminUserSchema.parse(res.body);
        expect(disabled.status).toBe('disabled');
        expect(disabled.disabledAt).toBe(api.clock.now().toISOString());
        expect(
          await api.db
            .select()
            .from(authSessions)
            .where(and(eq(authSessions.userId, p.id), isNull(authSessions.revokedAt))),
        ).toHaveLength(0);
        const [audit] = await h.audits('admin.user.disabled', p.id);
        expect(audit?.actorId).toBe(boss.id);
        expect((audit?.meta as { revokedSessions: number }).revokedSessions).toBeGreaterThan(0);

        // The access token still verifies but every route refuses it; refresh is over.
        const token = p.tokens.accessToken;
        for (const path of [apiPath(ME_ROUTES.get), apiPath(DRIVE_ROUTES.usage)]) {
          const blocked = await api.request('GET', path, { token });
          expect(blocked.status).toBe(403);
          expect(blocked.body).toMatchObject({ code: 'ACCOUNT_DISABLED' });
        }
        expect(
          (await h.bff(apiPath(AR.refresh), { refreshToken: p.tokens.refreshToken, pool: 'users' }))
            .body,
        ).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
        // ACCOUNT_DISABLED only with the right password.
        expect((await h.signIn(p.email ?? '', NEW_PW)).body).toMatchObject({
          code: 'ACCOUNT_DISABLED',
        });
        expect((await h.signIn(p.email ?? '', 'fake-Wrong-pw-666')).body).toMatchObject({
          code: 'INVALID_CREDENTIALS',
        });
        expect(await h.audits('auth.photographer.sign_in_disabled', p.id)).toHaveLength(1);
        // Shares stop working; nothing is deleted.
        const page = await browser.request('GET', `/api/s/${share.token}`);
        expect(page.body).toMatchObject({
          code: 'SHARE_EXPIRED',
          details: { reason: 'unavailable' },
        });
        const [kept] = await api.db.select().from(files).where(eq(files.id, file.id));
        expect(kept?.deletedAt).toBeNull();

        // Idempotent: a second disable writes nothing.
        await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: p.id }), {
          status: 'disabled',
        });
        expect(await h.audits('admin.user.disabled', p.id)).toHaveLength(1);

        // Enabling brings sign-in and the shares back (not the old sessions).
        const enabled = await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: p.id }), {
          status: 'active',
          name: 'Renamed Studio',
        });
        expect(adminUserSchema.parse(enabled.body)).toMatchObject({
          status: 'active',
          disabledAt: null,
          name: 'Renamed Studio',
        });
        expect(await h.audits('admin.user.enabled', p.id)).toHaveLength(1);
        const [renamed] = await h.audits('admin.user.updated', p.id);
        expect(renamed?.meta).toMatchObject({ changed: ['name'], newName: 'Renamed Studio' });
        expect((await browser.request('GET', `/api/s/${share.token}`)).status).toBe(200);
        expect(
          photographerSignInResponseSchema.parse((await h.signIn(p.email ?? '', NEW_PW)).body).step,
        ).toBe('signed_in');
      });

      it('refuses to disable or reset yourself (renaming is fine)', async () => {
        const self = apiPath(A.updateUser, { id: boss.id });
        const disable = await h.admin(boss.token, 'PATCH', self, { status: 'disabled' });
        expect(disable.status).toBe(403);
        expect(disable.body).toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
        const reset = await h.admin(boss.token, 'POST', apiPath(A.resetPassword, { id: boss.id }), {
          password: ADMIN_PW,
        });
        expect(reset.body).toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
        // The same id in upper case is still yourself.
        const upper = boss.id.toUpperCase();
        for (const res of [
          await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: upper }), {
            status: 'disabled',
          }),
          await h.admin(boss.token, 'POST', apiPath(A.resetPassword, { id: upper }), {
            password: ADMIN_PW,
          }),
        ]) {
          expect(res.status).toBe(403);
          expect(res.body).toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
        }
        const rename = await h.admin(boss.token, 'PATCH', self, { name: 'Boss' });
        expect(rename.status).toBe(200);
        expect(adminUserSchema.parse(rename.body).status).toBe('active');
      });

      it('resets a password: temporary again, sessions revoked, TOTP kept for admins', async () => {
        const p = await h.activePhotographer(boss.token, 'reset');
        expect(
          (await api.request('GET', apiPath(DRIVE_ROUTES.usage), { token: p.tokens.accessToken }))
            .status,
        ).toBe(200);
        const res = await h.admin(boss.token, 'POST', apiPath(A.resetPassword, { id: p.id }), {
          password: TEMP_PW,
        });
        expect(res.status).toBe(200);
        // The old access token ends at once, not when it expires.
        const stale = await api.request('GET', apiPath(DRIVE_ROUTES.usage), {
          token: p.tokens.accessToken,
        });
        expect(stale.status).toBe(401);
        expect(stale.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        expect(
          (await h.bff(apiPath(AR.refresh), { refreshToken: p.tokens.refreshToken, pool: 'users' }))
            .body,
        ).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
        expect(await h.audits('admin.user.password_reset', p.id)).toHaveLength(1);
        expect(
          photographerSignInResponseSchema.parse((await h.signIn(p.email ?? '', TEMP_PW)).body)
            .step,
        ).toBe('change_password');
        expect((await h.signIn(p.email ?? '', NEW_PW)).body).toMatchObject({
          code: 'INVALID_CREDENTIALS',
        });

        // An admin with TOTP: password step, then the code step with the existing secret.
        const other = await h.cliAdmin('reset-admin');
        await h.admin(boss.token, 'POST', apiPath(A.resetPassword, { id: other.id }), {
          password: ADMIN_PW.replace('4821', '4822'),
        });
        const adminAuth = await h.admin(other.token, 'GET', apiPath(A.listUsers));
        expect(adminAuth.status).toBe(401);
        api.clock.advance(31_000);
        const step1 = challengeStep(
          (
            await h.bff(apiPath(AR.adminLogin), {
              email: other.email,
              password: ADMIN_PW.replace('4821', '4822'),
            })
          ).body,
        );
        expect(step1.step).toBe('change_password');
        const step2 = changePasswordChallenge(
          (
            await h.bff(apiPath(AR.adminChangePassword), {
              challengeId: step1.challengeId,
              newPassword: 'fake-Admin-new-pw-6610',
            })
          ).body,
        );
        expect(step2.step).toBe('totp');
        const done = await h.bff(apiPath(AR.adminMfa), {
          challengeId: step2.challengeId,
          code: h.totp(other.secret),
        });
        expect(done.status).toBe(200);
      });
    });

    describe('admin created in the admin app: change password, enrol TOTP', () => {
      it('walks the steps and stores everything only with the first valid code', async () => {
        const address = email('ui-admin');
        const created = adminUserSchema.parse(
          (
            await h.admin(boss.token, 'POST', apiPath(A.createUser), {
              email: address,
              name: 'UI Admin',
              role: 'admin',
              password: ADMIN_PW,
            })
          ).body,
        );
        expect(created.totpEnrolled).toBe(false);
        const enrolled = async () =>
          adminUserSchema.parse(
            (await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: created.id }))).body,
          ).totpEnrolled;
        const credentials = async () =>
          (
            await api.db
              .select()
              .from(adminCredentials)
              .where(eq(adminCredentials.userId, created.id))
          )[0];
        const before = await credentials();

        const login = await h.bff(apiPath(AR.adminLogin), { email: address, password: ADMIN_PW });
        expect(login.status).toBe(200);
        const step1 = challengeStep(login.body);
        expect(step1.step).toBe('change_password');
        expect(JSON.stringify(login.body)).not.toMatch(/otpauth|accessToken/);

        // The challenge belongs to its step.
        expect(
          (await h.bff(apiPath(AR.adminMfa), { challengeId: step1.challengeId, code: '123456' }))
            .body,
        ).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
        // Weak or unchanged passwords keep the challenge usable.
        for (const [newPassword, reason] of [
          ['fake-pw-1', 'too_short'],
          [ADMIN_PW, 'same_as_current'],
        ] as const) {
          const weak = await h.bff(apiPath(AR.adminChangePassword), {
            challengeId: step1.challengeId,
            newPassword,
          });
          expect(weak.body).toMatchObject({ code: 'PASSWORD_TOO_WEAK', details: { reason } });
        }
        const changed = await h.bff(apiPath(AR.adminChangePassword), {
          challengeId: step1.challengeId,
          newPassword: 'fake-Admin-new-pw-7720',
        });
        expect(changed.status).toBe(200);
        const step2 = changePasswordChallenge(changed.body);
        if (step2.step !== 'enrol_totp') throw new Error('expected enrol_totp');
        expect(step2.otpauthUri).toContain(encodeURIComponent(address));
        // Used up.
        expect(
          (
            await h.bff(apiPath(AR.adminChangePassword), {
              challengeId: step1.challengeId,
              newPassword: 'fake-Admin-new-pw-7721',
            })
          ).body,
        ).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
        // Nothing stored yet.
        expect(await credentials()).toMatchObject({
          passwordHash: before?.passwordHash,
          mustChangePassword: true,
          totpSecretEncrypted: null,
        });
        expect(await h.audits('auth.admin.totp_enrolment_started', created.id)).toHaveLength(1);
        expect(await enrolled()).toBe(false);

        const secret = h.secretOf(step2.otpauthUri);
        const wrongCode = h.totp(secret) === '000000' ? '111111' : '000000';
        expect(
          (await h.bff(apiPath(AR.adminMfa), { challengeId: step2.challengeId, code: wrongCode }))
            .body,
        ).toMatchObject({ code: 'MFA_INVALID' });
        const done = await h.bff(apiPath(AR.adminMfa), {
          challengeId: step2.challengeId,
          code: h.totp(secret),
        });
        expect(done.status).toBe(200);
        const tokens = authTokenResponseSchema.parse(done.body);
        expect(await enrolled()).toBe(true);
        expect(decodeJwt(tokens.accessToken).amr).toEqual(['pwd', 'otp', 'mfa']);
        const after = await credentials();
        expect(after?.passwordHash).not.toBe(before?.passwordHash);
        expect(after).toMatchObject({ mustChangePassword: false, failedAttempts: 0 });
        expect(after?.totpSecretEncrypted).not.toBeNull();
        expect(after?.totpConfirmedAt).not.toBeNull();
        expect(await h.audits('auth.admin.password_changed', created.id)).toHaveLength(1);
        expect(await h.audits('auth.admin.totp_confirmed', created.id)).toHaveLength(1);
        expect(JSON.stringify(await api.db.select().from(auditLog))).not.toContain(secret);
        expect(api.logger.text()).not.toContain(secret);
        expect((await h.admin(tokens.accessToken, 'GET', apiPath(A.listUsers))).status).toBe(200);

        // Next time: the new password, then the code (no new enrolment).
        const next = await h.adminSignIn(address, 'fake-Admin-new-pw-7720', secret);
        expect(next.accessToken).toBeTruthy();
        expect(
          (await h.bff(apiPath(AR.adminLogin), { email: address, password: ADMIN_PW })).body,
        ).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      });

      it('leaves the account as it was when a sign-in is abandoned', async () => {
        const address = email('abandon');
        const created = adminUserSchema.parse(
          (
            await h.admin(boss.token, 'POST', apiPath(A.createUser), {
              email: address,
              name: 'Abandon',
              role: 'admin',
              password: ADMIN_PW,
            })
          ).body,
        );
        const walk = async () => {
          const s1 = challengeStep(
            (await h.bff(apiPath(AR.adminLogin), { email: address, password: ADMIN_PW })).body,
          );
          const s2 = changePasswordChallenge(
            (
              await h.bff(apiPath(AR.adminChangePassword), {
                challengeId: s1.challengeId,
                newPassword: 'fake-Admin-new-pw-8830',
              })
            ).body,
          );
          if (s2.step !== 'enrol_totp') throw new Error('expected enrol_totp');
          return s2.otpauthUri;
        };
        const first = await walk();
        const second = await walk();
        expect(h.secretOf(first)).not.toBe(h.secretOf(second));
        const [cred] = await api.db
          .select()
          .from(adminCredentials)
          .where(eq(adminCredentials.userId, created.id));
        expect(cred).toMatchObject({ mustChangePassword: true, totpSecretEncrypted: null });
      });

      it('answers ACCOUNT_DISABLED to a disabled admin, at sign-in and on admin routes', async () => {
        const other = await h.cliAdmin('to-disable');
        const res = await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: other.id }), {
          status: 'disabled',
        });
        expect(res.status).toBe(200);
        const routes = await h.admin(other.token, 'GET', apiPath(A.listUsers));
        expect(routes.status).toBe(403);
        expect(routes.body).toMatchObject({ code: 'ACCOUNT_DISABLED' });
        expect(
          (await h.bff(apiPath(AR.adminLogin), { email: other.email, password: ADMIN_PW })).body,
        ).toMatchObject({ code: 'ACCOUNT_DISABLED' });
        expect(
          (
            await h.bff(apiPath(AR.adminLogin), {
              email: other.email,
              password: 'fake-Wrong-pw-7777',
            })
          ).body,
        ).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      });
    });

    describe('act as a photographer (ADR 0018)', () => {
      it('opens the studio once, audits every change, and refuses the password change', async () => {
        // A photographer still on the temporary password: the admin isn't restricted by it.
        const p = await h.createPhotographer(boss.token, 'actas');
        const started = await h.admin(boss.token, 'POST', apiPath(A.actAs, { id: p.id }));
        expect(started.status).toBe(200);
        const link = actAsResponseSchema.parse(started.body);
        const url = new URL(link.url);
        expect(url.pathname).toBe('/auth/act-as');
        const code = url.searchParams.get('code') ?? '';
        expect(await h.audits('admin.user.act_as', p.id)).toHaveLength(1);

        const exchanged = await h.bff(apiPath(AR.actAs), { code });
        expect(exchanged.status).toBe(200);
        const tokens = authTokenResponseSchema.parse(exchanged.body);
        // ADMIN_ACT_AS_SESSION_SECONDS (default one hour), never the photographer's 30 days.
        expect(tokens.refreshExpiresIn).toBeLessThanOrEqual(3600);
        // The code works once.
        expect((await h.bff(apiPath(AR.actAs), { code })).status).toBe(401);

        const me = await api.request('GET', apiPath(ME_ROUTES.get), { token: tokens.accessToken });
        expect(me.status).toBe(200);
        expect(me.body).toMatchObject({
          id: p.id,
          passwordChangeRequired: false,
          actingAdmin: { id: boss.id },
        });

        // A change in the photographer's drive works, and is audited under the admin.
        const folder = await api.request('POST', apiPath(DRIVE_ROUTES.createFolder), {
          token: tokens.accessToken,
          body: { parentId: null, name: 'Fixed by admin' },
        });
        expect(folder.status).toBe(201);
        const requests = await h.audits('admin.act_as.request', p.id);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          actorId: boss.id,
          meta: { method: 'POST', route: DRIVE_ROUTES.createFolder.path },
        });
        // Reads aren't audited.
        await api.request('GET', apiPath(ME_ROUTES.get), { token: tokens.accessToken });
        expect(await h.audits('admin.act_as.request', p.id)).toHaveLength(1);

        // Never the password.
        const change = await h.changePassword(tokens.accessToken, TEMP_PW, NEW_PW);
        expect(change.status).toBe(403);

        // The photographer's own sign-in is unaffected (still the temporary password).
        expect((await h.signIn(p.email ?? '', TEMP_PW)).status).toBe(200);
      });

      it('refuses viewers, admins, disabled accounts and stale or unknown codes', async () => {
        const viewer = await api.viewer();
        expect(
          (await h.admin(boss.token, 'POST', apiPath(A.actAs, { id: viewer.id }))).status,
        ).toBe(404);
        expect((await h.admin(boss.token, 'POST', apiPath(A.actAs, { id: boss.id }))).status).toBe(
          404,
        );
        const p = await h.createPhotographer(boss.token, 'actas-disabled');
        await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: p.id }), {
          status: 'disabled',
        });
        expect((await h.admin(boss.token, 'POST', apiPath(A.actAs, { id: p.id }))).status).toBe(
          409,
        );
        const unknown = await h.bff(apiPath(AR.actAs), { code: 'A'.repeat(43) });
        expect(unknown.status).toBe(401);
        // Photographers' tokens can't start one.
        const photographer = await api.photographer();
        expect(
          (
            await api.request('POST', apiPath(A.actAs, { id: p.id }), {
              token: photographer.token,
            })
          ).status,
        ).not.toBe(200);
      });

      it('ends the session when the admin is disabled', async () => {
        const second = await h.cliAdmin('second-actas');
        const p = await h.createPhotographer(boss.token, 'actas-end');
        const link = actAsResponseSchema.parse(
          (await h.admin(second.token, 'POST', apiPath(A.actAs, { id: p.id }))).body,
        );
        const code = new URL(link.url).searchParams.get('code') ?? '';
        const tokens = authTokenResponseSchema.parse(
          (await h.bff(apiPath(AR.actAs), { code })).body,
        );
        const me = () => api.request('GET', apiPath(ME_ROUTES.get), { token: tokens.accessToken });
        expect((await me()).status).toBe(200);
        await h.admin(boss.token, 'PATCH', apiPath(A.updateUser, { id: second.id }), {
          status: 'disabled',
        });
        expect((await me()).status).toBe(401);
      });
    });

    describe('cash payments', () => {
      it('records idempotently per admin and key, with an audit row', async () => {
        const p = await h.createPhotographer(boss.token, 'cash');
        const body = {
          photographerId: p.id,
          amountSatang: 149_000,
          paidAt: '2026-10-24T03:00:00.000Z',
          note: '  เงินสด ตุลาคม  ',
        };
        const post = (token: string, key: string | null, b: unknown) =>
          h.admin(
            token,
            'POST',
            apiPath(A.createCashPayment),
            b,
            key === null ? undefined : { 'idempotency-key': key },
          );
        const first = await post(boss.token, 'cash-key-1', body);
        expect(first.status).toBe(201);
        const row = cashPaymentSchema.parse(first.body);
        expect(row).toMatchObject({
          photographerId: p.id,
          amountSatang: 149_000,
          note: 'เงินสด ตุลาคม',
          recordedById: boss.id,
        });
        // Same request (the same instant written another way): the same row.
        const replay = await post(boss.token, 'cash-key-1', {
          ...body,
          paidAt: '2026-10-24T10:00:00+07:00',
        });
        expect(replay.status).toBe(201);
        expect(replay.body).toEqual(first.body);
        // Same key, another request.
        const reused = await post(boss.token, 'cash-key-1', { ...body, amountSatang: 1 });
        expect(reused.status).toBe(422);
        expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
        // Concurrent first uses of one key make one row.
        const racers = await Promise.all(
          [1, 2, 3].map(() => post(boss.token, 'cash-key-race', body)),
        );
        expect(new Set(racers.map((r) => (r.body as { id: string }).id)).size).toBe(1);
        expect(
          await api.db.select().from(cashPayments).where(eq(cashPayments.photographerId, p.id)),
        ).toHaveLength(2);
        const audit = await h.audits('admin.cash_payment.created', row.id);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorId: boss.id,
          targetType: 'cash_payment',
          meta: { photographerId: p.id, amountSatang: 149_000, paidAt: body.paidAt },
        });

        // Another admin may use the same key.
        const other = await h.cliAdmin('cash-other');
        const theirs = await post(other.token, 'cash-key-1', body);
        expect(theirs.status).toBe(201);
        expect((theirs.body as { id: string }).id).not.toBe(row.id);

        // Validation and targets.
        expect((await post(boss.token, null, body)).body).toMatchObject({
          code: 'VALIDATION_FAILED',
        });
        const viewer = await api.viewer();
        expect(
          (await post(boss.token, 'cash-key-2', { ...body, photographerId: viewer.id })).status,
        ).toBe(404);
        expect(
          (await post(boss.token, 'cash-key-3', { ...body, photographerId: boss.id })).status,
        ).toBe(404);
        const future = new Date(api.clock.now().getTime() + 2 * 86_400_000).toISOString();
        expect(
          (await post(boss.token, 'cash-key-4', { ...body, paidAt: future })).body,
        ).toMatchObject({ code: 'VALIDATION_FAILED' });
        expect((await post(boss.token, 'cash-key-5', { ...body, amountSatang: 1.5 })).status).toBe(
          400,
        );

        const list = listCashPaymentsResponseSchema.parse(
          (
            await h.admin(
              boss.token,
              'GET',
              `${apiPath(A.listCashPayments)}?photographerId=${p.id}&limit=2`,
            )
          ).body,
        );
        expect(list.items).toHaveLength(2);
        expect(list.items.every((i) => i.photographerId === p.id)).toBe(true);
        const next = listCashPaymentsResponseSchema.parse(
          (
            await h.admin(
              boss.token,
              'GET',
              `${apiPath(A.listCashPayments)}?photographerId=${p.id}&limit=2&cursor=${encodeURIComponent(list.nextCursor ?? '')}`,
            )
          ).body,
        );
        expect(next.items.map((i) => i.id)).not.toContain(list.items[0]?.id);
        // Recording cash doesn't enable or change the account.
        expect(
          adminUserSchema.parse(
            (await h.admin(boss.token, 'GET', apiPath(A.getUser, { id: p.id }))).body,
          ).mustChangePassword,
        ).toBe(true);
      });
    });

    describe('billing offline, no storage limit', () => {
      it('answers NOT_FOUND on every billing route', async () => {
        const p = await h.activePhotographer(boss.token, 'billing');
        const token = p.tokens.accessToken;
        const calls = [
          api.request('GET', apiPath(B.plans)),
          api.request('POST', apiPath(B.checkout), {
            token,
            body: { planCode: 'pro', payment: { method: 'promptpay', months: 1 } },
            headers: { 'idempotency-key': 'k-1' },
          }),
          api.request('GET', apiPath(B.subscription), { token }),
          api.request('POST', apiPath(B.cancelSubscription), { token }),
          api.request('GET', apiPath(B.payment, { id: p.id }), { token }),
          api.request('POST', '/api/billing/webhooks/fake', { rawBody: '{}' }),
          api.request('GET', apiPath(B.plans), { token }),
        ];
        for (const res of await Promise.all(calls)) {
          expect(res.status).toBe(404);
          expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
        }
      });

      it('reserves and releases storage exactly without a quota or subscription', async () => {
        const p = await h.activePhotographer(boss.token, 'quota');
        const token = p.tokens.accessToken;
        const init = (size: number) =>
          api.request<{ fileId: string }>('POST', apiPath(UPLOAD_ROUTES.init), {
            token,
            body: { name: `IMG_${size}.JPG`, size, mime: 'image/jpeg', folderId: null },
          });
        const a = await init(12 * MiB);
        const b = await init(7 * MiB);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(await api.usage(p.id)).toMatchObject({ usedBytes: 0, reservedBytes: 19 * MiB });
        const usage = driveUsageResponseSchema.parse(
          (await api.request('GET', apiPath(DRIVE_ROUTES.usage), { token })).body,
        );
        expect(usage).toMatchObject({
          reservedBytes: 19 * MiB,
          quotaBytes: null,
          availableBytes: null,
          subscription: null,
          uploadsBlockedBy: null,
        });
        expect(
          (
            await api.request('DELETE', apiPath(UPLOAD_ROUTES.abort, { id: a.body.fileId }), {
              token,
            })
          ).status,
        ).toBe(204);
        expect(await api.usage(p.id)).toMatchObject({ usedBytes: 0, reservedBytes: 7 * MiB });
        // Sharing needs no subscription either, and the share serves.
        const folder = await api.folder(p.id, { name: 'Run' });
        const share = await api.request<{ token: string }>('POST', apiPath(SHARE_ROUTES.create), {
          token,
          body: { target: { type: 'folder', folderId: folder.id } },
        });
        expect(share.status).toBe(201);
        expect((await api.browser().request('GET', `/api/s/${share.body.token}`)).status).toBe(200);
        // Per-file limits still apply.
        const tooBig = await init(api.config.upload.maxBytes.image + 1);
        expect(tooBig.body).toMatchObject({ code: 'FILE_TOO_LARGE' });
      });
    });
  });

  describe.skipIf(!backend.enabled)(`ADR 0010 last active admin on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    const h = helpers(() => api);

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, { env: ENV });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    const activeAdmins = async () =>
      api.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));

    it('two admins disabling each other at once: exactly one wins', async () => {
      const a = await h.cliAdmin('race-a');
      const b = await h.cliAdmin('race-b');
      expect(await activeAdmins()).toHaveLength(2);
      const [ab, ba] = await Promise.all([
        h.admin(a.token, 'PATCH', apiPath(A.updateUser, { id: b.id }), { status: 'disabled' }),
        h.admin(b.token, 'PATCH', apiPath(A.updateUser, { id: a.id }), { status: 'disabled' }),
      ]);
      const outcomes = [ab, ba].map((r) =>
        r.status === 200 ? 'ok' : (r.body as { code: string }).code,
      );
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      // The loser is refused: LAST_ADMIN (checked under the lock), ACCOUNT_DISABLED (its own row
      // already disabled), or UNAUTHENTICATED (the winner revoked its session before the guard).
      expect(['LAST_ADMIN', 'ACCOUNT_DISABLED', 'UNAUTHENTICATED']).toContain(
        outcomes.find((o) => o !== 'ok'),
      );
      expect(await activeAdmins()).toHaveLength(1);
    });

    it('LAST_ADMIN when the change would leave no active admin (checked under row locks)', async () => {
      const remaining = await activeAdmins();
      expect(remaining).toHaveLength(1);
      const disabled = await api.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'disabled')));
      // The loser of a race acts after its own account was disabled: the service decides.
      const service = api.app.get(AdminUsersService);
      await expect(
        service.update(disabled[0]?.id ?? '', remaining[0]?.id ?? '', { status: 'disabled' }),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
      expect(await activeAdmins()).toHaveLength(1);
      // Nothing was audited for the refused change.
      expect(
        await api.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'admin.user.disabled'),
              inArray(auditLog.targetId, [remaining[0]?.id ?? '']),
            ),
          ),
      ).toHaveLength(0);
    });
  });
}
