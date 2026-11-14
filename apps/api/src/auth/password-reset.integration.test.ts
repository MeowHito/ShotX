import { randomUUID } from 'node:crypto';
import { auditLog, authSessions, userPasswordCredentials, users } from '@shotx/db';
import {
  apiPath,
  AUTH_ROUTES as AR,
  authProvidersResponseSchema,
  authTokenResponseSchema,
  PHOTOGRAPHER_PASSWORD_RESET_PATH,
  photographerSignInResponseSchema,
} from '@shotx/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { OFFLINE_ACCOUNTS_ENV } from '../testing/fakes';
import { TestApi } from '../testing/harness';
import { bffKeyFor, shotxEnv } from '../testing/shotx-auth';
import { FakeAccountMailer } from './account-email';
import { hashPassword } from './password';
import { PhotographerSignIn } from './photographer-sign-in';

// ADR 0025: a photographer resets a forgotten password through an emailed one-time link, and the
// photographer sign-in never asks anyone to wait (PHOTOGRAPHER_LOGIN_LIMITS_ENABLED=false). Every
// email is @example.test; every password is a made-up test value.

const OLD_PW = 'fake-Old-pw-5512';
const NEW_PW = 'fake-Reset-pw-8037';
const OTHER_PW = 'fake-Other-pw-2290';

const ENV = shotxEnv({
  ...OFFLINE_ACCOUNTS_ENV,
  ACCOUNT_EMAIL_PROVIDER: 'fake',
  PHOTOGRAPHER_PASSWORD_RESET_EMAILS_PER_HOUR: '2',
});

let counter = 0;
const nextIp = () => `198.51.100.${(counter % 250) + 1}`;

/** The token of the link in the last email to `to`. */
function tokenOf(mailer: FakeAccountMailer, to: string): string {
  const message = mailer.sent.filter((m) => m.to === to).at(-1);
  if (message === undefined) throw new Error(`no email to ${to}`);
  const match = /\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(message.text);
  if (match?.[1] === undefined) throw new Error('no reset link in the email');
  return match[1];
}

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`ADR 0025 password reset on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    const mailer = new FakeAccountMailer();

    const bff = (path: string, body: unknown, ip = nextIp()) =>
      api.request('POST', path, {
        body,
        headers: { 'x-shotx-bff-key': bffKeyFor(path, body), 'x-shotx-client-ip': ip },
      });
    const settled = () => api.app.get(PhotographerSignIn).settled();
    const requestReset = async (email: string) => {
      const res = await bff(apiPath(AR.photographerPasswordResetRequest), { email });
      await settled();
      return res;
    };
    const confirm = (token: string, newPassword: string) =>
      bff(apiPath(AR.photographerPasswordResetConfirm), { token, newPassword });
    const signIn = (email: string, password: string, ip?: string) =>
      bff(apiPath(AR.photographerSignIn), { email, password }, ip);

    /** An active photographer password account with OLD_PW (temporary unless `settled`). */
    async function photographer(
      opts: { status?: 'active' | 'disabled'; mustChange?: boolean } = {},
    ) {
      counter += 1;
      const email = `reset-${counter}-${randomUUID().slice(0, 6)}@example.test`;
      const [row] = await api.db
        .insert(users)
        .values({
          email,
          name: `ช่างภาพ ${counter}`,
          role: 'photographer',
          authPool: 'users',
          authSubject: `password:${randomUUID()}`,
          status: opts.status ?? 'active',
          ...(opts.status === 'disabled' ? { disabledAt: api.clock.now() } : {}),
        })
        .returning({ id: users.id });
      if (row === undefined) throw new Error('insert failed');
      await api.db.insert(userPasswordCredentials).values({
        userId: row.id,
        passwordHash: await hashPassword(OLD_PW, api.config.password.argon2id),
        mustChangePassword: opts.mustChange ?? false,
      });
      return { id: row.id, email };
    }

    const audits = (action: string, targetId: string) =>
      api.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db, { env: ENV, accountMailer: mailer });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    it('GET /auth/providers says the reset is available', async () => {
      const res = await api.request('GET', apiPath(AR.providers), {
        headers: { 'x-shotx-bff-key': bffKeyFor(apiPath(AR.providers), undefined) },
      });
      expect(res.status).toBe(200);
      expect(authProvidersResponseSchema.parse(res.body).passwordReset).toBe(true);
    });

    it('emails a link, sets the new password, signs in and ends the old sessions', async () => {
      const p = await photographer({ mustChange: true });
      const before = photographerSignInResponseSchema.parse((await signIn(p.email, OLD_PW)).body);

      // Any letter case of the email works.
      const res = await requestReset(p.email.toUpperCase());
      expect(res.status).toBe(204);
      const message = mailer.sent.filter((m) => m.to === p.email).at(-1);
      expect(message?.subject).toContain('ตั้งรหัสผ่านใหม่');
      expect(message?.text).toContain(`${PHOTOGRAPHER_PASSWORD_RESET_PATH}#token=`);
      expect(message?.html).toContain('ตั้งรหัสผ่านใหม่');
      const token = tokenOf(mailer, p.email);

      const done = await confirm(token, NEW_PW);
      expect(done.status).toBe(200);
      const session = authTokenResponseSchema.parse(done.body);
      expect(session.user.email).toBe(p.email);

      // The temporary flag is gone, the old session is revoked, the old password is refused.
      const [cred] = await api.db
        .select()
        .from(userPasswordCredentials)
        .where(eq(userPasswordCredentials.userId, p.id));
      expect(cred?.mustChangePassword).toBe(false);
      const refreshOld = await bff(apiPath(AR.refresh), {
        refreshToken: before.refreshToken,
        pool: 'users',
      });
      expect(refreshOld.status).toBe(401);
      expect((await signIn(p.email, OLD_PW)).body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      const after = photographerSignInResponseSchema.parse((await signIn(p.email, NEW_PW)).body);
      expect(after.step).toBe('signed_in');
      const live = await api.db
        .select()
        .from(authSessions)
        .where(and(eq(authSessions.userId, p.id), isNull(authSessions.revokedAt)));
      expect(live.length).toBe(2);

      // One use only.
      expect((await confirm(token, OTHER_PW)).body).toMatchObject({
        code: 'PASSWORD_RESET_INVALID',
      });
      expect(await audits('auth.photographer.password_reset', p.id)).toHaveLength(1);
      const requested = await audits('auth.photographer.password_reset_requested', p.id);
      expect(requested.map((r) => (r.meta as { outcome: string }).outcome)).toEqual(['sent']);
      // Nothing secret in the audit rows.
      expect(JSON.stringify(requested)).not.toContain(token);
      expect(JSON.stringify(requested)).not.toContain(p.email);
    });

    it('answers the same for unknown and disabled accounts, and sends them nothing', async () => {
      const disabled = await photographer({ status: 'disabled' });
      const before = mailer.sent.length;
      for (const email of ['nobody-here@example.test', disabled.email]) {
        const res = await requestReset(email);
        expect(res.status).toBe(204);
        expect(res.body).toBeFalsy();
      }
      expect(mailer.sent.length).toBe(before);
      const rows = await audits('auth.photographer.password_reset_requested', disabled.id);
      expect(rows.map((r) => (r.meta as { outcome: string }).outcome)).toEqual(['disabled']);
    });

    it('caps the emails per account per hour silently', async () => {
      const p = await photographer();
      for (let i = 0; i < 3; i += 1) expect((await requestReset(p.email)).status).toBe(204);
      expect(mailer.sent.filter((m) => m.to === p.email)).toHaveLength(2);
      api.clock.advance(3601_000);
      await requestReset(p.email);
      expect(mailer.sent.filter((m) => m.to === p.email)).toHaveLength(3);
    });

    it('voids the link when the password changes another way, or the account is disabled', async () => {
      const p = await photographer();
      await requestReset(p.email);
      const first = tokenOf(mailer, p.email);
      await requestReset(p.email);
      const second = tokenOf(mailer, p.email);
      expect(second).not.toBe(first);
      // The second link is used: the first one no longer matches the password.
      expect((await confirm(second, NEW_PW)).status).toBe(200);
      expect((await confirm(first, OTHER_PW)).body).toMatchObject({
        code: 'PASSWORD_RESET_INVALID',
      });

      const q = await photographer();
      await requestReset(q.email);
      const token = tokenOf(mailer, q.email);
      await api.db
        .update(users)
        .set({ status: 'disabled', disabledAt: api.clock.now() })
        .where(eq(users.id, q.id));
      expect((await confirm(token, NEW_PW)).body).toMatchObject({
        code: 'PASSWORD_RESET_INVALID',
      });
    });

    it('keeps the link usable after a weak password, and expires it after the TTL', async () => {
      const p = await photographer();
      await requestReset(p.email);
      const token = tokenOf(mailer, p.email);
      expect((await confirm(token, 'short')).body).toMatchObject({ code: 'PASSWORD_TOO_WEAK' });
      expect((await confirm(token, NEW_PW)).status).toBe(200);

      const q = await photographer();
      await requestReset(q.email);
      const late = tokenOf(mailer, q.email);
      api.clock.advance(
        (api.config.shotxAuth?.photographer.passwordReset.ttlSeconds ?? 0) * 1000 + 1000,
      );
      expect((await confirm(late, NEW_PW)).body).toMatchObject({ code: 'PASSWORD_RESET_INVALID' });
      expect((await confirm(randomTokenLike(), NEW_PW)).body).toMatchObject({
        code: 'PASSWORD_RESET_INVALID',
      });
    });

    it('drops the link when the email could not be sent', async () => {
      const p = await photographer();
      mailer.failNext = true;
      expect((await requestReset(p.email)).status).toBe(204);
      const rows = await audits('auth.photographer.password_reset_requested', p.id);
      expect(rows.map((r) => (r.meta as { outcome: string }).outcome)).toEqual(['send_failed']);
    });

    it('never makes a photographer wait, however many wrong passwords (limits off)', async () => {
      const p = await photographer();
      const ip = '198.51.100.250';
      for (let i = 0; i < 30; i += 1) {
        const res = await signIn(p.email, `fake-wrong-pw-${i}`, ip);
        expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      }
      const ok = await signIn(p.email, OLD_PW, ip);
      expect(ok.status).toBe(200);
      // A lock left over from when the limits were on is ignored too.
      await api.db
        .update(userPasswordCredentials)
        .set({ lockedUntil: new Date(api.clock.now().getTime() + 3600_000) })
        .where(eq(userPasswordCredentials.userId, p.id));
      expect((await signIn(p.email, OLD_PW, ip)).status).toBe(200);
    });
  });
}

/** A well-formed token nobody issued. */
function randomTokenLike(): string {
  return Buffer.from(randomUUID() + randomUUID())
    .toString('base64url')
    .slice(0, 43);
}

describe('ADR 0025 password reset without account email', () => {
  const backend = DATABASE_BACKENDS.find((b) => b.enabled);
  it.skipIf(backend === undefined)(
    'is FEATURE_DISABLED and not offered',
    async () => {
      if (backend === undefined) return;
      const database = await backend.open();
      const api = await TestApi.start(database.db, {
        env: shotxEnv({ ...OFFLINE_ACCOUNTS_ENV, ACCOUNT_EMAIL_PROVIDER: 'off' }),
      });
      try {
        const path = apiPath(AR.photographerPasswordResetRequest);
        const body = { email: 'someone@example.test' };
        const res = await api.request('POST', path, {
          body,
          headers: {
            'x-shotx-bff-key': bffKeyFor(path, body),
            'x-shotx-client-ip': '198.51.100.9',
          },
        });
        expect(res.body).toMatchObject({ code: 'FEATURE_DISABLED' });
        const providers = await api.request('GET', apiPath(AR.providers), {
          headers: { 'x-shotx-bff-key': bffKeyFor(apiPath(AR.providers), undefined) },
        });
        expect(authProvidersResponseSchema.parse(providers.body).passwordReset).toBe(false);
      } finally {
        await api.close();
        await database.close();
      }
    },
    120_000,
  );
});
