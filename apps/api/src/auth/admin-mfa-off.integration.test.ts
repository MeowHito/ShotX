import { adminCredentials, authSessions } from '@shotx/db';
import {
  ADMIN_ROUTES as A,
  adminChangePasswordResponseSchema,
  adminLoginResponseSchema,
  adminUserSchema,
  apiPath,
  AUTH_ROUTES as R,
  authTokenResponseSchema,
} from '@shotx/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdminOpsContext, createAdmin, resetAdminTotp } from '../cli/admin-ops';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { OFFLINE_ACCOUNTS_ENV } from '../testing/fakes';
import { TestApi } from '../testing/harness';
import { shotxEnv, TEST_ADMIN_BFF_KEY } from '../testing/shotx-auth';
import { refreshTokenHash } from './sessions';

// ADR 0011 decision 4: ADMIN_MFA_MODE=off (the default) signs admins in with email + password
// only. Lockout, rate limits, password policy, session liveness and the admin BFF key stay. A
// switch back to `totp` ends every password-only admin session. Passwords are made-up test values.

const PW = 'fake-Off-mode-pw-5150';
const TEMP = 'fake-Off-temp-pw-6261';
const NEW = 'fake-Fresh-admin-pw-7372';

let ipCounter = 0;
const nextIp = () => `192.0.2.${(ipCounter++ % 250) + 1}`;

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(
    `admin sign-in with ADMIN_MFA_MODE=off on ${backend.name}`,
    () => {
      let database: TestDatabase;
      let api: TestApi;

      beforeAll(async () => {
        database = await backend.open();
        api = await TestApi.start(database.db, {
          env: shotxEnv({ ...OFFLINE_ACCOUNTS_ENV, ADMIN_LOGIN_LOCKOUT_THRESHOLD: '3' }),
        });
      }, 120_000);

      afterAll(async () => {
        await api?.close();
        await database?.close();
      });

      const adminKey = (extra: Record<string, string> = {}) => ({
        'x-shotx-bff-key': TEST_ADMIN_BFF_KEY,
        'x-shotx-client-ip': nextIp(),
        ...extra,
      });
      const bff = (app: TestApi, path: string, body: unknown) =>
        app.request('POST', path, { body, headers: adminKey() });
      const ops = (app: TestApi): AdminOpsContext => {
        const admin = app.config.shotxAuth?.admin;
        if (admin === undefined || admin === null) throw new Error('admin sign-in is off');
        return {
          db: app.db,
          stage: app.config.app.stage,
          admin,
          argon2id: app.config.password.argon2id,
          now: () => app.clock.now(),
          operator: 'test-operator',
        };
      };
      const login = (email: string, password: string, app = api) =>
        bff(app, apiPath(R.adminLogin), { email, password });

      it('CLI create shows no enrolment; password sign-in answers signed_in with amr pwd', async () => {
        expect(api.config.shotxAuth?.admin?.mfaMode).toBe('off');
        const created = await createAdmin(ops(api), {
          email: 'off-boss@example.test',
          name: 'Off Boss',
          password: PW,
        });
        expect(created).toEqual({
          mfa: 'off',
          userId: created.userId,
          subject: `admin:${created.userId}`,
        });
        const [cred] = await api.db
          .select()
          .from(adminCredentials)
          .where(eq(adminCredentials.userId, created.userId));
        expect(cred).toMatchObject({ totpSecretEncrypted: null, mustChangePassword: false });

        const res = await login('off-boss@example.test', PW);
        expect(res.status).toBe(200);
        const step = adminLoginResponseSchema.parse(res.body);
        if (step.step !== 'signed_in') throw new Error(`expected signed_in, got ${step.step}`);
        expect(decodeJwt(step.accessToken)).toMatchObject({
          sub: created.subject,
          amr: ['pwd'],
          aud: 'shotx-admin',
        });
        const [session] = await api.db
          .select()
          .from(authSessions)
          .where(eq(authSessions.userId, created.userId));
        expect(session?.amr).toEqual(['pwd']);
        // The token works on admin routes (with the admin app's key) ...
        const list = await api.request('GET', apiPath(A.listUsers), {
          token: step.accessToken,
          headers: adminKey(),
        });
        expect(list.status).toBe(200);
        // ... the MFA route has nothing to do ...
        const mfa = await bff(api, apiPath(R.adminMfa), {
          challengeId: 'x'.repeat(43),
          code: '123456',
        });
        expect(mfa.body).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
        // ... and refresh keeps exactly the sign-in's methods.
        const refreshed = await bff(api, apiPath(R.refresh), {
          refreshToken: step.refreshToken,
          pool: 'admins',
        });
        expect(refreshed.status).toBe(200);
        expect(decodeJwt(authTokenResponseSchema.parse(refreshed.body).accessToken).amr).toEqual([
          'pwd',
        ]);
        // reset-totp needs ADMIN_MFA_MODE=totp.
        await expect(resetAdminTotp(ops(api), 'off-boss@example.test')).rejects.toThrow(
          /ADMIN_MFA_MODE=totp/,
        );
      });

      it('a temporary password: change_password, then signed_in after storing the new one', async () => {
        const boss = adminLoginResponseSchema.parse(
          (await login('off-boss@example.test', PW)).body,
        );
        if (boss.step !== 'signed_in') throw new Error('expected signed_in');
        const createdRes = await api.request('POST', apiPath(A.createUser), {
          token: boss.accessToken,
          headers: adminKey(),
          body: { email: 'off-new@example.test', name: 'New', role: 'admin', password: TEMP },
        });
        expect(createdRes.status).toBe(201);
        const created = adminUserSchema.parse(createdRes.body);

        const first = adminLoginResponseSchema.parse(
          (await login('off-new@example.test', TEMP)).body,
        );
        if (first.step !== 'change_password') throw new Error('expected change_password');
        expect(JSON.stringify(first)).not.toMatch(/otpauth|accessToken/);
        const weak = await bff(api, apiPath(R.adminChangePassword), {
          challengeId: first.challengeId,
          newPassword: TEMP,
        });
        expect(weak.body).toMatchObject({
          code: 'PASSWORD_TOO_WEAK',
          details: { reason: 'same_as_current' },
        });
        const changed = await bff(api, apiPath(R.adminChangePassword), {
          challengeId: first.challengeId,
          newPassword: NEW,
        });
        expect(changed.status).toBe(200);
        const done = adminChangePasswordResponseSchema.parse(changed.body);
        if (done.step !== 'signed_in') throw new Error(`expected signed_in, got ${done.step}`);
        expect(decodeJwt(done.accessToken).amr).toEqual(['pwd']);
        const [cred] = await api.db
          .select()
          .from(adminCredentials)
          .where(eq(adminCredentials.userId, created.id));
        expect(cred).toMatchObject({ mustChangePassword: false, totpSecretEncrypted: null });
        // The challenge is used up; the temporary password is gone; the new one signs in directly.
        expect(
          (
            await bff(api, apiPath(R.adminChangePassword), {
              challengeId: first.challengeId,
              newPassword: 'fake-Off-other-pw-8483',
            })
          ).body,
        ).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
        expect((await login('off-new@example.test', TEMP)).body).toMatchObject({
          code: 'INVALID_CREDENTIALS',
        });
        expect(
          adminLoginResponseSchema.parse((await login('off-new@example.test', NEW)).body).step,
        ).toBe('signed_in');
      });

      it('keeps the lockout: wrong passwords lock, then even the right one is RATE_LIMITED', async () => {
        await createAdmin(ops(api), { email: 'off-lock@example.test', name: 'Lock', password: PW });
        for (let i = 0; i < 3; i++) {
          expect((await login('off-lock@example.test', 'fake-Wrong-pw-9594')).status).toBe(401);
        }
        expect((await login('off-lock@example.test', PW)).status).toBe(429);
      });

      it('switching ADMIN_MFA_MODE to totp ends password-only admin sessions', async () => {
        const signedIn = adminLoginResponseSchema.parse(
          (await login('off-boss@example.test', PW)).body,
        );
        if (signedIn.step !== 'signed_in') throw new Error('expected signed_in');
        // The same database and keys, restarted with the second factor back on.
        const totp = await TestApi.start(database.db, {
          env: shotxEnv({ ...OFFLINE_ACCOUNTS_ENV, ADMIN_MFA_MODE: 'totp' }),
        });
        try {
          const route = await totp.request('GET', apiPath(A.listUsers), {
            token: signedIn.accessToken,
            headers: adminKey(),
          });
          expect(route.status).toBe(401);
          expect(route.body).toMatchObject({ code: 'MFA_REQUIRED' });
          const refresh = await bff(totp, apiPath(R.refresh), {
            refreshToken: signedIn.refreshToken,
            pool: 'admins',
          });
          expect(refresh.body).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
          // The family was revoked, so it can't be used even after switching back.
          const [session] = await totp.db
            .select()
            .from(authSessions)
            .where(
              and(
                eq(authSessions.refreshTokenHash, refreshTokenHash(signedIn.refreshToken)),
                isNull(authSessions.revokedAt),
              ),
            );
          expect(session).toBeUndefined();
          // A sign-in under totp asks for the code step (enrolment: the account has no secret).
          const step = adminLoginResponseSchema.parse(
            (await login('off-boss@example.test', PW, totp)).body,
          );
          expect(step.step).toBe('enrol_totp');
        } finally {
          await totp.close();
        }
      });
    },
  );
}
