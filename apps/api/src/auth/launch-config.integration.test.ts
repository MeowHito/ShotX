import { randomUUID } from 'node:crypto';
import { users } from '@shotx/db';
import {
  apiPath,
  AUTH_ROUTES as AR,
  authProvidersOf,
  DROPPED_EMAIL_MESSAGE_ID,
  type EmailProvider,
  SHARE_ROUTES as S,
  viewerLoginAvailable,
} from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiConfig } from '../config';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { OFFLINE_ACCOUNTS_ENV, testConfig, testEnv } from '../testing/fakes';
import { TestApi } from '../testing/harness';
import { localAuthEnv, shotxEnv, TEST_BFF_KEY } from '../testing/shotx-auth';
import { EMAIL_PROVIDER } from '../tokens';
import { oidcStateKey } from './auth.service';
import { startSession } from './sessions';
import { ShotxTokenIssuer } from './shotx-tokens';

// The launch configuration (2026-11-11): APP_STAGE=prod-like, EMAIL_PROVIDER=off without SES_*,
// no LINE/Google. The API must boot, drop email without logging recipients, list no OIDC
// providers, and refuse `require_login` shares that no viewer could open.

const NO_OIDC = {
  LINE_LOGIN_CHANNEL_ID: '',
  LINE_LOGIN_CHANNEL_SECRET: '',
  GOOGLE_OAUTH_CLIENT_ID: '',
  GOOGLE_OAUTH_CLIENT_SECRET: '',
};

/** Prod-like: stage prod, offline billing (no gateway secret), email off, no OIDC. */
const LAUNCH_ENV = shotxEnv({
  ...OFFLINE_ACCOUNTS_ENV,
  ...NO_OIDC,
  APP_STAGE: 'prod',
  EMAIL_PROVIDER: 'off',
  EMAIL_FROM_ADDRESS: '',
  PAYMENT_FAKE_WEBHOOK_SECRET: '',
});

const RECIPIENT = 'runner-42@example.test';

describe('launch configuration loads', () => {
  it('reads no SES or sender with EMAIL_PROVIDER=off, and no OIDC provider', () => {
    const config = loadApiConfig(testEnv(LAUNCH_ENV));
    expect(config.app.stage).toBe('prod');
    expect(config.email).toEqual({ provider: 'off', from: null });
    expect(config.sesClient).toBeNull();
    expect(config.paymentGateway).toBeNull();
    const auth = config.shotxAuth;
    if (auth === null) throw new Error('expected shotx auth');
    expect(authProvidersOf(auth)).toEqual({ oidc: [], devLogin: false, adminLogin: true });
    expect(viewerLoginAvailable(authProvidersOf(auth))).toBe(false);
  });

  it('a viewer can sign in with one provider, or with the dev login locally', () => {
    const google = testConfig(
      shotxEnv({ LINE_LOGIN_CHANNEL_ID: '', LINE_LOGIN_CHANNEL_SECRET: '' }),
    ).shotxAuth;
    const local = testConfig(localAuthEnv(NO_OIDC)).shotxAuth;
    if (google === null || local === null) throw new Error('expected shotx auth');
    expect(authProvidersOf(google).oidc).toEqual(['google']);
    expect(viewerLoginAvailable(authProvidersOf(google))).toBe(true);
    expect(authProvidersOf(local)).toMatchObject({ oidc: [], devLogin: true });
    expect(viewerLoginAvailable(authProvidersOf(local))).toBe(true);
  });
});

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`launch configuration on ${backend.name}`, () => {
    let database: TestDatabase;
    let launch: TestApi;
    let withOidc: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      launch = await TestApi.start(database.db, { env: LAUNCH_ENV, configuredEmail: true });
      withOidc = await TestApi.start(database.db, { env: shotxEnv(OFFLINE_ACCOUNTS_ENV) });
    }, 120_000);

    afterAll(async () => {
      await launch?.close();
      await withOidc?.close();
      await database?.close();
    });

    const bff = (api: TestApi, method: string, path: string, body?: unknown) =>
      api.request(method, path, {
        ...(body === undefined ? {} : { body }),
        headers: { 'x-shotx-bff-key': TEST_BFF_KEY, 'x-shotx-client-ip': '203.0.113.20' },
      });

    /** A LINE photographer with a live ShotX session (no admin needed for these routes). */
    async function photographer(api: TestApi) {
      const subject = `line:U-${randomUUID()}`;
      const [row] = await api.db
        .insert(users)
        .values({ authPool: 'users', authSubject: subject, role: 'photographer' })
        .returning();
      const auth = api.config.shotxAuth;
      if (row === undefined || auth === null) throw new Error('no user');
      const session = await startSession(api.db, {
        userId: row.id,
        pool: 'users',
        now: api.clock.now(),
        ttlSeconds: 3600,
      });
      const { token } = await new ShotxTokenIssuer(
        api.config.app.stage,
        auth,
        api.clock,
      ).accessToken('users', { subject, sessionId: session.familyId, amr: ['fed'] });
      return { id: row.id, token };
    }

    it('lists no OIDC provider; start and callback answer AUTH_PROVIDER_UNAVAILABLE', async () => {
      const providers = await bff(launch, 'GET', apiPath(AR.providers));
      expect(providers.status).toBe(200);
      expect(providers.body).toEqual({ oidc: [], devLogin: false, adminLogin: true });
      for (const provider of ['line', 'google'] as const) {
        const start = await bff(launch, 'POST', apiPath(AR.oidcStart, { provider }), {
          redirectUri: 'http://localhost:3000/auth/callback',
        });
        expect(start.body).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
      }
      // A sign-in started before the provider was switched off.
      const state = 'S'.repeat(43);
      await launch.store.setWithTtl(
        oidcStateKey(state),
        JSON.stringify({
          provider: 'google',
          nonce: 'n'.repeat(43),
          codeVerifier: 'v'.repeat(43),
          redirectUri: 'http://localhost:3000/auth/callback',
        }),
        600,
      );
      const callback = await bff(launch, 'POST', apiPath(AR.oidcCallback), {
        state,
        code: 'code-1',
      });
      expect(callback.body).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    });

    it('drops email with EMAIL_PROVIDER=off and logs the template only', async () => {
      const email = launch.app.get<EmailProvider>(EMAIL_PROVIDER);
      const result = await email.send({
        template: 'grace_started',
        to: RECIPIENT,
        idempotencyKey: `grace:${randomUUID()}`,
        params: { name: 'Runner', planName: 'Pro', graceEndsAt: '2026-12-01T00:00:00.000Z' },
      } as never);
      expect(result).toEqual({ messageId: DROPPED_EMAIL_MESSAGE_ID, dropped: true });
      const log = launch.logger.text();
      expect(log).toContain('"event":"email.dropped"');
      expect(log).toContain('"template":"grace_started"');
      expect(log).not.toContain(RECIPIENT);
      expect(log).not.toContain('Runner');
    });

    it('refuses require_login shares no viewer could open (create and turning it on)', async () => {
      const p = await photographer(launch);
      const folder = await launch.folder(p.id, { name: 'Race' });
      const target = { type: 'folder', folderId: folder.id };
      const refused = await launch.request('POST', apiPath(S.create), {
        token: p.token,
        body: { target, requireLogin: true },
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'LOGIN_PROVIDER_UNAVAILABLE' });

      const open = await launch.request<{ id: string }>('POST', apiPath(S.create), {
        token: p.token,
        body: { target },
      });
      expect(open.status).toBe(201);
      const turnOn = await launch.request('PATCH', apiPath(S.update, { id: open.body.id }), {
        token: p.token,
        body: { requireLogin: true },
      });
      expect(turnOn.body).toMatchObject({ code: 'LOGIN_PROVIDER_UNAVAILABLE' });
      // A PATCH without requireLogin keeps an existing require_login share editable.
      const existing = await launch.share(p.id, { folderId: folder.id }, { requireLogin: true });
      const edit = await launch.request('PATCH', apiPath(S.update, { id: existing.id }), {
        token: p.token,
        body: { allowDownload: false },
      });
      expect(edit.status).toBe(200);
      const off = await launch.request('PATCH', apiPath(S.update, { id: existing.id }), {
        token: p.token,
        body: { requireLogin: false },
      });
      expect(off.status).toBe(200);
    });

    it('allows require_login when a viewer provider is configured', async () => {
      const p = await photographer(withOidc);
      const folder = await withOidc.folder(p.id, { name: 'Race' });
      const created = await withOidc.request<{ id: string }>('POST', apiPath(S.create), {
        token: p.token,
        body: { target: { type: 'folder', folderId: folder.id }, requireLogin: true },
      });
      expect(created.status).toBe(201);
      const again = await withOidc.request('PATCH', apiPath(S.update, { id: created.body.id }), {
        token: p.token,
        body: { requireLogin: true },
      });
      expect(again.status).toBe(200);
    });
  });
}
