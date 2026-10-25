import { randomUUID } from 'node:crypto';
import { users } from '@shotx/db';
import { apiErrorBodySchema, apiPath, DRIVE_ROUTES } from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type TestDatabase } from './testing/database';
import { TestApi } from './testing/harness';

// Bootstrap, routing, error format and auth for both Cognito pools (ADR 0002).

let database: TestDatabase;
let api: TestApi;
const usagePath = apiPath(DRIVE_ROUTES.usage);

beforeAll(async () => {
  database = await openPglite();
  api = await TestApi.start(database.db, { limits: { jsonBodyMaxBytes: 1024 } });
}, 60_000);

afterAll(async () => {
  await api?.close();
  await database?.close();
});

describe('bootstrap', () => {
  it('serves the health check at /api/health without auth', async () => {
    const res = await api.request('GET', '/api/health');
    expect(res).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  it('routes case-sensitively and strictly, under /api only', async () => {
    for (const path of ['/api/Health', '/api/health/', '/health', '/API/health']) {
      const res = await api.request('GET', path);
      expect(res.status, path).toBe(404);
      expect(apiErrorBodySchema.parse(res.body).code).toBe('NOT_FOUND');
    }
  });

  it('answers malformed JSON with VALIDATION_FAILED and big bodies with PAYLOAD_TOO_LARGE', async () => {
    const p = await api.photographer();
    const bad = await api.request('POST', apiPath(DRIVE_ROUTES.createFolder), {
      token: p.token,
      rawBody: '{"name": ',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    const big = await api.request('POST', apiPath(DRIVE_ROUTES.createFolder), {
      token: p.token,
      body: { parentId: null, name: 'x'.repeat(2000) },
    });
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('reports validation issues with paths, never the values', async () => {
    const p = await api.photographer();
    const res = await api.request('POST', apiPath(DRIVE_ROUTES.createFolder), {
      token: p.token,
      body: { parentId: 'secret-value', name: '' },
    });
    expect(res.status).toBe(400);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('secret-value');
    const body = res.body as { code: string; details: { issues: { path: unknown[] }[] } };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.issues.map((i) => i.path)).toContainEqual(['body', 'parentId']);
  });
});

describe('auth', () => {
  it('rejects requests without a token', async () => {
    const res = await api.request('GET', usagePath);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('accepts users-pool access and ID tokens of a photographer', async () => {
    const p = await api.photographer();
    expect((await api.request('GET', usagePath, { token: p.token })).status).toBe(200);
    const idToken = await api.auth.token('users', p.sub, { tokenUse: 'id' });
    expect((await api.request('GET', usagePath, { token: idToken })).status).toBe(200);
  });

  it('never lets an admins-pool token act as a photographer', async () => {
    const sub = randomUUID();
    await api.db.insert(users).values({ cognitoPool: 'admins', cognitoSub: sub, role: 'admin' });
    const token = await api.auth.token('admins', sub);
    const res = await api.request('GET', usagePath, { token });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('maps users by (pool, sub): an admins-pool sub equal to a photographer sub gets nothing', async () => {
    const p = await api.photographer();
    // Same sub, but a token of the admins pool (validly signed by that pool).
    const token = await api.auth.token('admins', p.sub);
    expect((await api.request('GET', usagePath, { token })).status).toBe(401);
  });

  it('rejects tokens signed by the other pool, with a foreign issuer, client, use or expired', async () => {
    const p = await api.photographer();
    const forged = [
      await api.auth.token('users', p.sub, { signWith: 'admins' }),
      await api.auth.token('users', p.sub, { issuer: 'https://evil.example.com/pool' }),
      await api.auth.token('users', p.sub, { clientId: 'otherclient' }),
      await api.auth.token('users', p.sub, { tokenUse: 'id', clientId: 'otherclient' }),
      await api.auth.token('users', p.sub, { expiresIn: '-1m' }),
      await api.auth.token('users', p.sub, { extra: { token_use: 'refresh' } }),
      'not-a-jwt',
    ];
    for (const token of forged) {
      const res = await api.request('GET', usagePath, { token });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('is FORBIDDEN for a users-pool identity that is not a photographer, whatever its groups claim', async () => {
    const viewer = await api.photographer({ role: 'user' });
    const token = await api.auth.token('users', viewer.sub, {
      extra: { 'cognito:groups': ['photographer', 'admin'] },
    });
    const res = await api.request('GET', usagePath, { token });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    const unknown = await api.auth.token('users', randomUUID());
    expect((await api.request('GET', usagePath, { token: unknown })).status).toBe(403);
  });
});
