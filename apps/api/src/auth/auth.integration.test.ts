import { adminCredentials, auditLog, authSessions, users } from '@shotx/db';
import {
  adminLoginResponseSchema,
  AUTH_ROUTES as R,
  apiPath,
  authProvidersResponseSchema,
  authTokenResponseSchema,
  type AuthTokenResponse,
  oidcStartResponseSchema,
} from '@shotx/shared';
import { and, eq, like } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import type { ExecutionContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminOpsContext,
  createAdmin,
  resetAdminPassword,
  resetAdminTotp,
  unlockAdmin,
} from '../cli/admin-ops';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi, type TestResponse } from '../testing/harness';
import {
  bffKeyFor,
  FakeOidcProviders,
  localAuthEnv,
  shotxEnv,
  TEST_BFF_KEY,
  TEST_GOOGLE_CLIENT_ID,
  TEST_LINE_CHANNEL_ID,
} from '../testing/shotx-auth';
import { tokenVerifier } from '../wiring';
import { AdminGuard } from './admin.guard';
import { base32Decode, hotp, totpStep } from './totp';

const CALLBACK = 'http://localhost:3000/auth/callback';
let ipCounter = 0;
/** A fresh client address per caller, passed like web does (trusted with the BFF key). */
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`/auth on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    let providers: FakeOidcProviders;

    beforeAll(async () => {
      database = await backend.open();
      let clockNow: () => Date = () => new Date();
      providers = await FakeOidcProviders.create(() => clockNow());
      api = await TestApi.start(database.db, {
        env: shotxEnv({
          AUTH_LOGIN_RATE_PER_IP: '5',
          ADMIN_LOGIN_RATE_PER_ACCOUNT: '4',
          ADMIN_LOGIN_RATE_PER_IP: '6',
          ADMIN_LOGIN_LOCKOUT_THRESHOLD: '3',
        }),
        oidc: (clock) => {
          clockNow = () => clock.now();
          return providers.deps(() => clock.now());
        },
      });
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    /**
     * A BFF call: the calling app's key plus the end user's address. The admin app's key for the
     * admin sign-in steps and admins-pool refreshes (BffKeyScope), web's otherwise.
     */
    const bff = <T = unknown>(
      method: string,
      path: string,
      body?: unknown,
      ip = nextIp(),
      key = bffKeyFor(path, body),
    ): Promise<TestResponse<T>> =>
      api.request<T>(method, path, {
        body,
        headers: { 'x-shotx-bff-key': key, 'x-shotx-client-ip': ip },
      });

    const start = (provider: 'line' | 'google', ip?: string) =>
      bff('POST', apiPath(R.oidcStart, { provider }), { redirectUri: CALLBACK }, ip);

    /** A full LINE or Google sign-in with the given ID token claims. */
    async function oidcSignIn(
      provider: 'line' | 'google',
      claims: Record<string, unknown>,
    ): Promise<TestResponse<AuthTokenResponse>> {
      const started = await start(provider);
      expect(started.status).toBe(200);
      const { authorizationUrl, state } = oidcStartResponseSchema.parse(started.body);
      const back = providers.authorize(authorizationUrl, claims);
      expect(back.state).toBe(state);
      return bff('POST', apiPath(R.oidcCallback), { state, code: back.code });
    }

    describe('BFF key', () => {
      it('is required (constant-time compare) on every /auth route', async () => {
        for (const key of ['', 'wrong-key-0123456789abcdef0123456789']) {
          const res = await bff('GET', apiPath(R.providers), undefined, undefined, key);
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        }
        const none = await api.request('POST', apiPath(R.refresh), {
          body: { refreshToken: 'x'.repeat(43), pool: 'users' },
        });
        expect(none.status).toBe(401);
      });

      it('lists the configured providers', async () => {
        const res = await bff('GET', apiPath(R.providers));
        expect(res.status).toBe(200);
        expect(authProvidersResponseSchema.parse(res.body)).toEqual({
          oidc: ['line', 'google'],
          devLogin: false,
          adminLogin: true,
        });
      });
    });

    describe('LINE and Google (OIDC + PKCE)', () => {
      it('starts with state, nonce and a PKCE S256 challenge kept one-time in Redis', async () => {
        const res = await start('google');
        expect(res.status).toBe(200);
        const { authorizationUrl, state } = oidcStartResponseSchema.parse(res.body);
        const url = new URL(authorizationUrl);
        expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          response_type: 'code',
          client_id: TEST_GOOGLE_CLIENT_ID,
          redirect_uri: CALLBACK,
          scope: 'openid profile email',
          state,
          code_challenge_method: 'S256',
        });
        expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const keys = api.store.keys().filter((k) => k.startsWith('auth:oidc:'));
        expect(keys.length).toBeGreaterThan(0);
        // The state itself is not the key, and the TTL is AUTH_LOGIN_STATE_TTL_SECONDS.
        expect(keys.some((k) => k.includes(state))).toBe(false);
        expect(api.store.ttlSeconds(keys.at(-1) ?? '')).toBe(600);
      });

      it('accepts only the exact web callback as redirect URI', async () => {
        for (const redirectUri of [
          'http://localhost:3000/auth/callback/',
          'http://localhost:3000/auth/callback?x=1',
          'http://localhost:3000/other',
          'https://evil.example/auth/callback',
          'http://localhost:3000.evil.example/auth/callback',
        ]) {
          const res = await bff('POST', apiPath(R.oidcStart, { provider: 'line' }), {
            redirectUri,
          });
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
        }
      });

      it('signs in with Google: verified email only, subject google:<sub>, users pool', async () => {
        const res = await oidcSignIn('google', {
          sub: '110169484474386276334',
          email: 'somchai@example.com',
          email_verified: true,
          name: 'สมชาย',
        });
        expect(res.status).toBe(200);
        const tokens = authTokenResponseSchema.parse(res.body);
        expect(tokens.user).toEqual({ email: 'somchai@example.com', name: 'สมชาย' });
        expect(tokens.expiresIn).toBe(900);
        expect(tokens.refreshExpiresIn).toBe(30 * 86_400);
        const claims = decodeJwt(tokens.accessToken);
        expect(claims).toMatchObject({
          sub: 'google:110169484474386276334',
          idp: 'google',
          amr: ['fed'],
          iss: 'urn:shotx:test:auth:users',
          aud: 'shotx-web',
        });
        // The token works on users routes; the user row is a viewer.
        const me = await api.request<{ role: string; email: string }>('GET', '/api/me', {
          token: tokens.accessToken,
        });
        expect(me.status).toBe(200);
        expect(me.body).toMatchObject({ role: 'user', email: 'somchai@example.com' });
        // The token exchange went to Google's token endpoint with PKCE and a timeout.
        const call = providers.tokenRequests.at(-1);
        expect(call?.url).toBe('https://oauth2.googleapis.com/token');
        expect(call?.form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(call?.signal).toBe(true);

        // A second sign-in is the same account; nothing about it changes.
        const again = await oidcSignIn('google', {
          sub: '110169484474386276334',
          email: 'changed@example.com',
          email_verified: true,
        });
        expect(authTokenResponseSchema.parse(again.body).user.email).toBe('somchai@example.com');
        const rows = await api.db
          .select()
          .from(users)
          .where(eq(users.authSubject, 'google:110169484474386276334'));
        expect(rows).toHaveLength(1);
      });

      it('ignores unverified emails (and LINE emails, which carry no verified flag)', async () => {
        const google = await oidcSignIn('google', {
          sub: 'g-unverified',
          email: 'x@example.com',
          email_verified: false,
        });
        expect(authTokenResponseSchema.parse(google.body).user.email).toBeNull();
        const line = await oidcSignIn('line', {
          sub: 'U4af4980629',
          email: 'line@example.com',
          name: 'Line User',
        });
        expect(line.status).toBe(200);
        const tokens = authTokenResponseSchema.parse(line.body);
        expect(tokens.user).toEqual({ email: null, name: 'Line User' });
        expect(decodeJwt(tokens.accessToken)).toMatchObject({ sub: 'line:U4af4980629' });
        expect(providers.tokenRequests.at(-1)?.form.get('client_id')).toBe(TEST_LINE_CHANNEL_ID);
      });

      it('uses the state once', async () => {
        const started = oidcStartResponseSchema.parse((await start('line')).body);
        const back = providers.authorize(started.authorizationUrl, { sub: 'U-once' });
        const first = await bff('POST', apiPath(R.oidcCallback), {
          state: back.state,
          code: back.code,
        });
        expect(first.status).toBe(200);
        const replay = await bff('POST', apiPath(R.oidcCallback), {
          state: back.state,
          code: back.code,
        });
        expect(replay.status).toBe(400);
        expect(replay.body).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
        const unknown = await bff('POST', apiPath(R.oidcCallback), {
          state: 'A'.repeat(43),
          code: 'x',
        });
        expect(unknown.body).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
      });

      it('expires the state after AUTH_LOGIN_STATE_TTL_SECONDS', async () => {
        const started = oidcStartResponseSchema.parse((await start('google')).body);
        const back = providers.authorize(started.authorizationUrl, { sub: 'late' });
        api.clock.advance(601_000);
        const res = await bff('POST', apiPath(R.oidcCallback), {
          state: back.state,
          code: back.code,
        });
        expect(res.body).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
      });

      it('maps provider failures to IDENTITY_PROVIDER_ERROR reasons', async () => {
        const cases: [Parameters<typeof attempt>[1], string][] = [
          [{ kind: 'status', status: 503 }, 'unavailable'],
          [{ kind: 'network' }, 'unavailable'],
          [{ kind: 'status', status: 400 }, 'exchange_failed'],
          [{ kind: 'no-id-token' }, 'exchange_failed'],
          [{ kind: 'wrong-key' }, 'id_token_invalid'],
          [{ kind: 'claims', claims: { nonce: 'other-nonce' } }, 'id_token_invalid'],
          [{ kind: 'claims', claims: { aud: 'someone-else' } }, 'id_token_invalid'],
          [{ kind: 'claims', claims: { iss: 'https://evil.example' } }, 'id_token_invalid'],
          [
            {
              kind: 'claims',
              claims: { exp: Math.floor(api.clock.now().getTime() / 1000) - 10 },
            },
            'id_token_invalid',
          ],
        ];
        for (const provider of ['line', 'google'] as const) {
          for (const [fault, reason] of cases) {
            const res = await attempt(provider, fault);
            expect(res.status, `${provider} ${fault.kind} ${reason}`).toBe(502);
            expect(res.body).toMatchObject({
              code: 'IDENTITY_PROVIDER_ERROR',
              details: { provider, reason },
            });
          }
        }
        // Google's second documented issuer is fine.
        const alt = await attempt('google', {
          kind: 'claims',
          claims: { iss: 'accounts.google.com' },
        });
        expect(alt.status).toBe(200);
      });

      async function attempt(
        provider: 'line' | 'google',
        fault: NonNullable<FakeOidcProviders['nextFault']>,
      ): Promise<TestResponse> {
        const started = oidcStartResponseSchema.parse((await start(provider)).body);
        const back = providers.authorize(started.authorizationUrl, { sub: `fault-${provider}` });
        providers.nextFault = fault;
        return bff('POST', apiPath(R.oidcCallback), { state: back.state, code: back.code });
      }

      it('rate-limits sign-in starts per client IP', async () => {
        const ip = '203.0.113.50';
        for (let i = 0; i < 5; i++) expect((await start('line', ip)).status).toBe(200);
        const blocked = await start('line', ip);
        expect(blocked.status).toBe(429);
        expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
        expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
        // Another address is not affected (the BFF passes the end user's IP).
        expect((await start('line', '203.0.113.51')).status).toBe(200);
      });

      it('answers NOT_FOUND for the dev login outside local mode', async () => {
        const res = await bff('POST', apiPath(R.devLogin), { email: 'a@b.co', name: 'A' });
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      });
    });

    describe('refresh and logout', () => {
      const refresh = (refreshToken: string, pool: 'users' | 'admins' = 'users') =>
        bff<AuthTokenResponse>('POST', apiPath(R.refresh), { refreshToken, pool });

      it('rotates on use and keeps the family expiry', async () => {
        const signIn = authTokenResponseSchema.parse(
          (await oidcSignIn('line', { sub: 'U-rotate' })).body,
        );
        api.clock.advance(3_600_000);
        const res = await refresh(signIn.refreshToken);
        expect(res.status).toBe(200);
        const next = authTokenResponseSchema.parse(res.body);
        expect(next.refreshToken).not.toBe(signIn.refreshToken);
        expect(next.refreshExpiresIn).toBe(signIn.refreshExpiresIn - 3600);
        expect(decodeJwt(next.accessToken).sid).toBe(decodeJwt(signIn.accessToken).sid);
        const sid = String(decodeJwt(next.accessToken).sid);
        const rows = await api.db.select().from(authSessions).where(eq(authSessions.familyId, sid));
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.expiresAt.getTime())).size).toBe(1);
        // Only hashes are stored.
        for (const row of rows) {
          expect(row.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
          expect(row.refreshTokenHash).not.toBe(next.refreshToken);
        }
      });

      it('answers the same successor to a parallel refresh within the grace window', async () => {
        const signIn = authTokenResponseSchema.parse(
          (await oidcSignIn('line', { sub: 'U-parallel' })).body,
        );
        const [a, b] = await Promise.all([
          refresh(signIn.refreshToken),
          refresh(signIn.refreshToken),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.refreshToken).toBe(b.body.refreshToken);
        expect((await refresh(a.body.refreshToken)).status).toBe(200);
      });

      it('revokes the whole family when a rotated token comes back after the grace window', async () => {
        const signIn = authTokenResponseSchema.parse(
          (await oidcSignIn('google', { sub: 'g-reuse' })).body,
        );
        const next = authTokenResponseSchema.parse((await refresh(signIn.refreshToken)).body);
        api.clock.advance(11_000);
        const reused = await refresh(signIn.refreshToken);
        expect(reused.status).toBe(401);
        expect(reused.body).toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
        // The legitimate successor is dead too.
        const after = await refresh(next.refreshToken);
        expect(after.body).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
        const [user] = await api.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.authSubject, 'google:g-reuse'));
        const audit = await api.db
          .select()
          .from(auditLog)
          .where(
            and(eq(auditLog.action, 'auth.refresh_reused'), eq(auditLog.actorId, user?.id ?? '')),
          );
        expect(audit).toHaveLength(1);
      });

      it('refuses unknown tokens, the other pool and expired families', async () => {
        expect((await refresh('B'.repeat(43))).body).toMatchObject({
          code: 'REFRESH_TOKEN_INVALID',
        });
        const signIn = authTokenResponseSchema.parse(
          (await oidcSignIn('line', { sub: 'U-pool' })).body,
        );
        expect((await refresh(signIn.refreshToken, 'admins')).body).toMatchObject({
          code: 'REFRESH_TOKEN_INVALID',
        });
        api.clock.advance(30 * 86_400_000 + 1000);
        expect((await refresh(signIn.refreshToken)).body).toMatchObject({
          code: 'REFRESH_TOKEN_INVALID',
        });
      });

      it('logs out by revoking the family (idempotent)', async () => {
        const signIn = authTokenResponseSchema.parse(
          (await oidcSignIn('line', { sub: 'U-logout' })).body,
        );
        const out = await bff('POST', apiPath(R.logout), { refreshToken: signIn.refreshToken });
        expect(out.status).toBe(204);
        expect(
          (await bff('POST', apiPath(R.logout), { refreshToken: signIn.refreshToken })).status,
        ).toBe(204);
        expect((await refresh(signIn.refreshToken)).body).toMatchObject({
          code: 'REFRESH_TOKEN_INVALID',
        });
      });
    });

    describe('admin sign-in (password + TOTP)', () => {
      const ops = (): AdminOpsContext => {
        const admin = api.config.shotxAuth?.admin;
        if (admin === undefined || admin === null) throw new Error('admin sign-in is off');
        return {
          db: api.db,
          stage: api.config.app.stage,
          admin,
          argon2id: api.config.password.argon2id,
          now: () => api.clock.now(),
          operator: 'test-operator',
        };
      };
      const password = 'correct horse battery staple';
      const code = (secretBase32: string, offsetSteps = 0) =>
        hotp(base32Decode(secretBase32), totpStep(api.clock.now().getTime(), 30) + offsetSteps, 6);
      const login = (email: string, pw: string, ip?: string) =>
        bff('POST', apiPath(R.adminLogin), { email, password: pw }, ip);
      const mfa = (challengeId: string, c: string, ip?: string) =>
        bff<AuthTokenResponse>('POST', apiPath(R.adminMfa), { challengeId, code: c }, ip);
      const audits = (action: string) =>
        api.db.select().from(auditLog).where(eq(auditLog.action, action));

      it('creates an admin (CLI), confirms TOTP with the first code, issues pwd+otp tokens', async () => {
        const enrolment = await createAdmin(ops(), {
          email: 'Ops@Example.com',
          name: 'Ops',
          password,
        });
        expect(enrolment.subject).toBe(`admin:${enrolment.userId}`);
        expect(enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
        const [cred] = await api.db
          .select()
          .from(adminCredentials)
          .where(eq(adminCredentials.userId, enrolment.userId));
        expect(cred?.totpConfirmedAt).toBeNull();
        expect(cred?.passwordHash).toMatch(/^\$argon2id\$/);
        expect(cred?.mustChangePassword).toBe(false);
        expect(cred?.totpSecretEncrypted?.toString('latin1')).not.toContain(
          base32Decode(enrolment.secretBase32).toString('latin1'),
        );
        expect((await audits('auth.admin.created')).at(-1)?.targetId).toBe(enrolment.userId);

        const step1 = await login('ops@example.com', password);
        expect(step1.status).toBe(200);
        const { challengeId } = adminLoginResponseSchema.parse(step1.body);
        // No token of any kind before the TOTP step.
        expect(JSON.stringify(step1.body)).not.toMatch(/accessToken|refreshToken/);

        const wrong = await mfa(
          challengeId,
          '000000' === code(enrolment.secretBase32) ? '111111' : '000000',
        );
        expect(wrong.status).toBe(401);
        expect(wrong.body).toMatchObject({ code: 'MFA_INVALID' });

        const ok = await mfa(challengeId, code(enrolment.secretBase32));
        expect(ok.status).toBe(200);
        const tokens = authTokenResponseSchema.parse(ok.body);
        expect(decodeJwt(tokens.accessToken)).toMatchObject({
          sub: enrolment.subject,
          amr: ['pwd', 'otp', 'mfa'],
          iss: 'urn:shotx:test:auth:admins',
          aud: 'shotx-admin',
        });
        expect(tokens.refreshExpiresIn).toBe(12 * 3600);
        expect(tokens.user).toEqual({ email: 'Ops@Example.com', name: 'Ops' });
        const [after] = await api.db
          .select()
          .from(adminCredentials)
          .where(eq(adminCredentials.userId, enrolment.userId));
        expect(after?.totpConfirmedAt).not.toBeNull();
        expect(after?.failedAttempts).toBe(0);
        expect((await audits('auth.admin.totp_confirmed')).length).toBe(1);
        expect((await audits('auth.admin.sign_in')).at(-1)?.actorId).toBe(enrolment.userId);

        // The challenge was used up; the admins token is refused on users routes.
        expect((await mfa(challengeId, code(enrolment.secretBase32, 1))).body).toMatchObject({
          code: 'LOGIN_STATE_INVALID',
        });
        const me = await api.request('GET', '/api/me', { token: tokens.accessToken });
        expect(me.status).toBe(401);

        // Admin refresh keeps amr and the pool; a users-pool refresh of it is refused.
        const refreshed = await bff<AuthTokenResponse>('POST', apiPath(R.refresh), {
          refreshToken: tokens.refreshToken,
          pool: 'admins',
        });
        expect(refreshed.status).toBe(200);
        expect(decodeJwt(refreshed.body.accessToken).amr).toEqual(['pwd', 'otp', 'mfa']);

        // Replay: the same code (same step) on a new challenge is refused.
        const again = adminLoginResponseSchema.parse(
          (await login('ops@example.com', password)).body,
        );
        const replay = await mfa(again.challengeId, code(enrolment.secretBase32));
        expect(replay.body).toMatchObject({ code: 'MFA_INVALID' });
        expect(
          (await audits('auth.admin.mfa_failed')).some((r) => r.meta.reason === 'replayed'),
        ).toBe(true);
      });

      it('answers unknown emails and wrong passwords alike, and audits both', async () => {
        await createAdmin(ops(), { email: 'known@example.com', name: 'Known', password });
        const unknown = await login('nobody@example.com', password);
        const wrong = await login('known@example.com', 'not the password at all');
        for (const res of [unknown, wrong]) {
          expect(res.status).toBe(401);
          expect(res.body).toEqual({
            code: 'INVALID_CREDENTIALS',
            message: 'Wrong email or password',
          });
        }
        const failed = await audits('auth.admin.sign_in_failed');
        const anonymous = failed.filter((r) => r.actorId === null);
        expect(anonymous.length).toBeGreaterThan(0);
        expect(anonymous.at(-1)?.targetType).toBe('admin_login');
        expect(anonymous.at(-1)?.targetId).toMatch(/^v1:/);
        expect(JSON.stringify(failed)).not.toContain('nobody@example.com');
        expect(failed.some((r) => r.targetType === 'user')).toBe(true);
      });

      it('locks known and unknown accounts alike after the threshold, until the CLI unlocks', async () => {
        await createAdmin(ops(), { email: 'lock@example.com', name: 'Lock', password });
        for (const email of ['lock@example.com', 'nobody-lock@example.com']) {
          for (let i = 0; i < 3; i++) {
            expect((await login(email, 'wrong password!!')).body).toMatchObject({
              code: 'INVALID_CREDENTIALS',
            });
          }
        }
        // Known (even with the right password) and unknown answer the same.
        const known = await login('lock@example.com', password);
        const unknown = await login('nobody-lock@example.com', password);
        for (const res of [known, unknown]) {
          expect(res.status).toBe(429);
          expect(res.body).toEqual({
            code: 'RATE_LIMITED',
            message: 'Too many sign-in attempts; try again later',
          });
          expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
        }
        const locked = await audits('auth.admin.locked');
        expect(locked.filter((r) => r.actorId === null)).toHaveLength(1);
        expect(locked.filter((r) => r.actorId !== null)).toHaveLength(1);

        await unlockAdmin(ops(), 'lock@example.com');
        expect((await audits('auth.admin.unlocked')).length).toBe(1);
        // The per-account window (4 attempts) still runs out on its own.
        api.clock.advance(901_000);
        expect((await login('lock@example.com', password)).status).toBe(200);
        // The unknown lock ends after ADMIN_LOGIN_LOCKOUT_SECONDS (900 s) too.
        expect((await login('nobody-lock@example.com', password)).status).toBe(401);
      });

      it('counts every attempt per account and per IP before evaluating it', async () => {
        await createAdmin(ops(), { email: 'window@example.com', name: 'W', password });
        const ip = nextIp();
        // Successes count too: 4 attempts per account window.
        for (let i = 0; i < 4; i++) {
          expect((await login('window@example.com', password, ip)).status).toBe(200);
        }
        expect((await login('window@example.com', password, ip)).status).toBe(429);
        api.clock.advance(901_000);
        const other = '203.0.113.77';
        for (let i = 0; i < 6; i++) {
          expect((await login(`ip-${i}@example.com`, 'whatever-password', other)).status).toBe(401);
        }
        expect((await login('ip-x@example.com', 'whatever-password', other)).status).toBe(429);
      });

      it('evaluates at most the limit of a burst of parallel wrong passwords', async () => {
        const { userId } = await createAdmin(ops(), {
          email: 'burst-pw@example.com',
          name: 'B',
          password,
        });
        const results = await Promise.all(
          Array.from({ length: 25 }, () => login('burst-pw@example.com', 'wrong password!!')),
        );
        const evaluated = results.filter((r) => r.status === 401).length;
        expect(evaluated).toBeGreaterThan(0);
        expect(evaluated).toBeLessThanOrEqual(3); // the lockout threshold (< the window of 4)
        expect(results.every((r) => r.status === 401 || r.status === 429)).toBe(true);
        const rows = (await audits('auth.admin.sign_in_failed')).filter(
          (r) => r.actorId === userId && r.meta.reason === 'invalid_credentials',
        );
        expect(rows.length).toBe(evaluated);
      });

      it('evaluates at most the limit of a burst of parallel wrong codes', async () => {
        const enrolment = await createAdmin(ops(), {
          email: 'burst-otp@example.com',
          name: 'B',
          password,
        });
        const { challengeId } = adminLoginResponseSchema.parse(
          (await login('burst-otp@example.com', password)).body,
        );
        const right = code(enrolment.secretBase32);
        const wrongCodes = Array.from({ length: 30 }, (_, i) =>
          String((Number(right) + 1 + i) % 1_000_000).padStart(6, '0'),
        );
        const results = await Promise.all(wrongCodes.map((c) => mfa(challengeId, c)));
        const evaluated = results.filter((r) => r.status === 401).length;
        expect(evaluated).toBeGreaterThan(0);
        expect(evaluated).toBeLessThanOrEqual(3);
        const rows = (await audits('auth.admin.mfa_failed')).filter(
          (r) => r.actorId === enrolment.userId && r.meta.reason === 'invalid_code',
        );
        expect(rows.length).toBe(evaluated);
        // The account locked and the challenge is gone, so even the right code is refused now.
        expect((await mfa(challengeId, right)).body).toMatchObject({
          code: 'LOGIN_STATE_INVALID',
        });
      });

      it('never leaves a refusal without an expiring lock (double-submit race)', async () => {
        const { userId } = await createAdmin(ops(), {
          email: 'race@example.com',
          name: 'R',
          password,
        });
        const setCount = (n: number) =>
          api.db
            .update(adminCredentials)
            .set({ failedAttempts: n, lockedUntil: null })
            .where(eq(adminCredentials.userId, userId));
        const credentials = async () =>
          (
            await api.db.select().from(adminCredentials).where(eq(adminCredentials.userId, userId))
          )[0];

        // The state the race used to leave: count at the threshold, no lock. The next attempt
        // locks with an expiry (and the Retry-After comes true) instead of refusing forever.
        await setCount(3);
        const refused = await login('race@example.com', password);
        expect(refused.status).toBe(429);
        const retryAfter = Number(refused.headers.get('retry-after'));
        expect(retryAfter).toBe(900);
        const locked = await credentials();
        expect(locked?.lockedUntil?.getTime()).toBe(api.clock.now().getTime() + 900_000);
        expect(locked?.failedAttempts).toBe(0);
        expect((await audits('auth.admin.locked')).some((r) => r.actorId === userId)).toBe(true);
        api.clock.advance(retryAfter * 1000 + 1000);
        expect((await login('race@example.com', password)).status).toBe(200);

        // The race itself: count at threshold - 1, a correct password and a wrong one at once.
        api.clock.advance(901_000);
        await setCount(2);
        const [right, wrong] = await Promise.all([
          login('race@example.com', password),
          login('race@example.com', 'wrong password!!'),
        ]);
        expect([200, 429]).toContain(right.status);
        expect([401, 429]).toContain(wrong.status);
        const after = await credentials();
        const now = api.clock.now().getTime();
        if (after !== undefined && after.failedAttempts >= 3) {
          throw new Error('count at or past the threshold without a lock');
        }
        if (after?.lockedUntil != null && after.lockedUntil.getTime() > now) {
          expect(after.lockedUntil.getTime()).toBeLessThanOrEqual(now + 900_000);
          api.clock.advance(901_000);
        }
        api.clock.advance(901_000);
        expect((await login('race@example.com', password)).status).toBe(200);
      });

      it('admin guard: needs a live session, refused after a reset or lockout', async () => {
        const enrolment = await createAdmin(ops(), {
          email: 'guard@example.com',
          name: 'G',
          password,
        });
        const { challengeId } = adminLoginResponseSchema.parse(
          (await login('guard@example.com', password)).body,
        );
        const tokens = authTokenResponseSchema.parse(
          (await mfa(challengeId, code(enrolment.secretBase32))).body,
        );
        const verifier = tokenVerifier(api.config, api.clock);
        const guard = new AdminGuard(verifier, api.db, api.clock);
        const context = {
          switchToHttp: () => ({
            getRequest: () => ({ headers: { authorization: `Bearer ${tokens.accessToken}` } }),
          }),
        } as unknown as ExecutionContext;
        await expect(guard.canActivate(context)).resolves.toBe(true);
        // A lockout only blocks new sign-ins: the live session keeps working (no sign-out by
        // guessing someone's password), while a new sign-in is refused.
        await api.db
          .update(adminCredentials)
          .set({ lockedUntil: new Date(api.clock.now().getTime() + 60_000) })
          .where(eq(adminCredentials.userId, enrolment.userId));
        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect((await login('guard@example.com', password)).status).toBe(429);
        await unlockAdmin(ops(), 'guard@example.com');
        await expect(guard.canActivate(context)).resolves.toBe(true);
        // An operator reset revokes the sessions.
        await resetAdminTotp(ops(), 'guard@example.com');
        await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      });

      it('refuses a first sign-in after ADMIN_TOTP_ENROLMENT_TTL_SECONDS until reset-totp', async () => {
        const first = await createAdmin(ops(), { email: 'late@example.com', name: 'L', password });
        api.clock.advance(7 * 86_400_000 + 1000);
        const c1 = adminLoginResponseSchema.parse((await login('late@example.com', password)).body);
        const refused = await mfa(c1.challengeId, code(first.secretBase32));
        expect(refused.status).toBe(401);
        expect(refused.body).toMatchObject({ code: 'MFA_INVALID' });
        expect(
          (await audits('auth.admin.mfa_failed')).some(
            (r) => r.actorId === first.userId && r.meta.reason === 'enrolment_expired',
          ),
        ).toBe(true);
        const [cred] = await api.db
          .select()
          .from(adminCredentials)
          .where(eq(adminCredentials.userId, first.userId));
        expect(cred?.totpConfirmedAt).toBeNull();

        const second = await resetAdminTotp(ops(), 'late@example.com');
        const c2 = adminLoginResponseSchema.parse((await login('late@example.com', password)).body);
        expect((await mfa(c2.challengeId, code(second.secretBase32))).status).toBe(200);
        // Once confirmed, the enrolment age no longer matters.
        api.clock.advance(8 * 86_400_000);
        const c3 = adminLoginResponseSchema.parse((await login('late@example.com', password)).body);
        expect((await mfa(c3.challengeId, code(second.secretBase32))).status).toBe(200);
      });

      it('resets TOTP (new secret, unconfirmed, sessions revoked) and passwords via the CLI', async () => {
        const first = await createAdmin(ops(), { email: 'reset@example.com', name: 'R', password });
        const { challengeId } = adminLoginResponseSchema.parse(
          (await login('reset@example.com', password)).body,
        );
        const tokens = authTokenResponseSchema.parse(
          (await mfa(challengeId, code(first.secretBase32))).body,
        );
        const second = await resetAdminTotp(ops(), 'reset@example.com');
        expect(second.secretBase32).not.toBe(first.secretBase32);
        expect(
          (
            await bff('POST', apiPath(R.refresh), {
              refreshToken: tokens.refreshToken,
              pool: 'admins',
            })
          ).body,
        ).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
        api.clock.advance(31_000);
        const c2 = adminLoginResponseSchema.parse(
          (await login('reset@example.com', password)).body,
        );
        expect((await mfa(c2.challengeId, code(first.secretBase32))).body).toMatchObject({
          code: 'MFA_INVALID',
        });
        expect((await mfa(c2.challengeId, code(second.secretBase32))).status).toBe(200);

        await resetAdminPassword(ops(), 'reset@example.com', 'a brand new passphrase');
        expect((await login('reset@example.com', password)).status).toBe(401);
        expect((await login('reset@example.com', 'a brand new passphrase')).status).toBe(200);
        await expect(resetAdminPassword(ops(), 'reset@example.com', 'short')).rejects.toThrow(
          /at least/,
        );
        await expect(
          createAdmin(ops(), { email: 'RESET@example.com', name: 'dup', password }),
        ).rejects.toThrow(/already exists/);
        const ops2 = await api.db
          .select()
          .from(auditLog)
          .where(
            and(like(auditLog.action, 'auth.admin.%_reset'), eq(auditLog.targetId, first.userId)),
          );
        expect(ops2.map((r) => r.action).sort()).toEqual([
          'auth.admin.password_reset',
          'auth.admin.totp_reset',
        ]);
      });
    });
  });
}

describe('/auth in other modes', () => {
  const backend = DATABASE_BACKENDS[0];
  let database: TestDatabase;

  beforeAll(async () => {
    database = await backend.open();
  }, 120_000);
  afterAll(async () => {
    await database?.close();
  });

  it('answers NOT_FOUND on every route with AUTH_PROVIDER=cognito', async () => {
    const api = await TestApi.start(database.db);
    try {
      const res = await api.request('GET', apiPath(R.providers), {
        headers: { 'x-shotx-bff-key': TEST_BFF_KEY },
      });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await api.close();
    }
  });

  it('refuses the BFF key on requests that came through the public proxy', async () => {
    // The test client connects from 127.0.0.1; make that the reverse proxy's address.
    const api = await TestApi.start(database.db, {
      env: shotxEnv({ TRUSTED_PROXY_ADDRESSES: '127.0.0.1' }),
    });
    try {
      const res = await api.request('GET', apiPath(R.providers), {
        headers: { 'x-shotx-bff-key': TEST_BFF_KEY, 'x-shotx-client-ip': '203.0.113.5' },
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally {
      await api.close();
    }
  });

  it('local mode: dev login issues users-pool tokens (amr dev) that the API accepts', async () => {
    const api = await TestApi.start(database.db, {
      env: localAuthEnv({ LINE_LOGIN_CHANNEL_ID: '', LINE_LOGIN_CHANNEL_SECRET: '' }),
    });
    try {
      const headers = { 'x-shotx-bff-key': TEST_BFF_KEY };
      const providers = await api.request('GET', apiPath(R.providers), { headers });
      expect(providers.body).toEqual({ oidc: ['google'], devLogin: true, adminLogin: true });
      const unavailable = await api.request('POST', apiPath(R.oidcStart, { provider: 'line' }), {
        headers,
        body: { redirectUri: 'http://localhost:3000/auth/callback' },
      });
      expect(unavailable.status).toBe(404);
      expect(unavailable.body).toMatchObject({
        code: 'AUTH_PROVIDER_UNAVAILABLE',
        details: { provider: 'line' },
      });
      const res = await api.request<AuthTokenResponse>('POST', apiPath(R.devLogin), {
        headers,
        body: { email: 'Dev@Example.com', name: 'Dev' },
      });
      expect(res.status).toBe(200);
      const tokens = authTokenResponseSchema.parse(res.body);
      expect(decodeJwt(tokens.accessToken)).toMatchObject({
        sub: 'local:dev@example.com',
        idp: 'local',
        amr: ['dev'],
        iss: 'urn:shotx:local:auth:users',
      });
      const me = await api.request('GET', '/api/me', { token: tokens.accessToken });
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ email: 'Dev@Example.com', role: 'user' });
    } finally {
      await api.close();
    }
  });
});
