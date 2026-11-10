import { generateKeyPairSync } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import {
  AUTH_TOKEN_AUDIENCES,
  authTokenIssuer,
  BULLMQ_QUEUE_DEFAULTS,
  bullMqJobOptions,
  bullMqQueueOptions,
  loadQueueBackendConfig,
  OIDC_PROVIDER_METADATA,
} from '@shotx/shared';
import type { Request } from 'express';
import { decodeJwt, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { clientIpTrust } from '../config';
import { clientIp, cloudFrontOriginHeaders, hasValidBffKey, secretMatches } from '../http/client';
import { MemoryKeyValueStore, MemoryRateLimiter } from '../infra/redis';
import { TestClock, testConfig } from '../testing/fakes';
import {
  ed25519PrivateKeyBase64,
  ed25519PublicKeyBase64,
  localAuthEnv,
  shotxEnv,
  TEST_ADMIN_BFF_KEY,
  TEST_BFF_KEY,
} from '../testing/shotx-auth';
import type { Db } from '../db/db';
import type { TokenVerifier } from '../tokens';
import { AdminGuard } from './admin.guard';
import { adminAccountKey, normalizeAdminEmail } from './admin-sign-in';
import { pkceChallenge } from './oidc';
import { storeRefreshGrace } from './sessions';
import { amrForSubject, ShotxTokenIssuer, ShotxTokenVerifier } from './shotx-tokens';
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  hotp,
  matchTotp,
  otpauthUri,
} from './totp';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');

  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(rfcSecret, Math.floor(seconds / 30), 8)).toBe(code);
    }
    // RFC 4226 appendix D, 6 digits.
    expect(hotp(rfcSecret, 0, 6)).toBe('755224');
    expect(hotp(rfcSecret, 9, 6)).toBe('520489');
  });

  it('round-trips base32 (RFC 4648 vectors)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(base32Decode(base32Encode(rfcSecret))).toEqual(rfcSecret);
    expect(() => base32Decode('A1')).toThrow(RangeError);
  });

  it('accepts codes inside the window only, and never a step at or before the last used one', () => {
    const nowMs = 1_111_111_111_000;
    const step = Math.floor(nowMs / 30_000);
    const check = { nowMs, periodSeconds: 30, digits: 6 as const, window: 1, lastUsedStep: null };
    expect(matchTotp(rfcSecret, hotp(rfcSecret, step, 6), check)).toBe(step);
    expect(matchTotp(rfcSecret, hotp(rfcSecret, step - 1, 6), check)).toBe(step - 1);
    expect(matchTotp(rfcSecret, hotp(rfcSecret, step + 1, 6), check)).toBe(step + 1);
    expect(matchTotp(rfcSecret, hotp(rfcSecret, step - 2, 6), check)).toBeNull();
    expect(matchTotp(rfcSecret, hotp(rfcSecret, step, 6), { ...check, window: 0 })).toBe(step);
    // Replays: the step already used, and earlier steps.
    expect(matchTotp(rfcSecret, hotp(rfcSecret, step, 6), { ...check, lastUsedStep: step })).toBe(
      null,
    );
    expect(
      matchTotp(rfcSecret, hotp(rfcSecret, step - 1, 6), { ...check, lastUsedStep: step - 1 }),
    ).toBeNull();
    // Wrong length or non-digits.
    expect(matchTotp(rfcSecret, hotp(rfcSecret, step, 8), check)).toBeNull();
    expect(matchTotp(rfcSecret, 'abcdef', check)).toBeNull();
  });

  it('encrypts the secret with AES-256-GCM bound to the user id', () => {
    const key = new Uint8Array(32).fill(7);
    const userId = '0199b2a0-0000-7000-8000-000000000001';
    const enc = encryptTotpSecret(key, userId, rfcSecret);
    expect(enc.nonce).toHaveLength(12);
    expect(enc.ciphertext).toHaveLength(rfcSecret.length + 16);
    expect(decryptTotpSecret(key, userId, enc)).toEqual(rfcSecret);
    expect(() => decryptTotpSecret(key, '0199b2a0-0000-7000-8000-000000000002', enc)).toThrow();
    expect(() => decryptTotpSecret(new Uint8Array(32).fill(8), userId, enc)).toThrow();
    // A fresh nonce every time.
    expect(encryptTotpSecret(key, userId, rfcSecret).nonce).not.toEqual(enc.nonce);
  });

  it('builds an otpauth URI authenticator apps accept', () => {
    const uri = new URL(
      otpauthUri({
        issuer: 'ShotX Admin (test)',
        account: 'a@example.com',
        secret: rfcSecret,
        digits: 6,
        periodSeconds: 30,
      }),
    );
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/ShotX Admin (test):a@example.com');
    expect(uri.searchParams.get('secret')).toBe(base32Encode(rfcSecret));
    expect(uri.searchParams.get('issuer')).toBe('ShotX Admin (test)');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});

describe('ShotX access tokens', () => {
  const clock = new TestClock();
  const config = testConfig(shotxEnv());
  const auth = config.shotxAuth;
  if (auth === null) throw new Error('shotxAuth missing');
  const issuer = new ShotxTokenIssuer('test', auth, clock);
  const verifier = new ShotxTokenVerifier('test', auth, clock);
  const sid = '0199b2a0-0000-7000-8000-0000000000aa';

  /** Signs arbitrary claims with the users key (for forged-token tests). */
  const forge = async (
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
    key = auth.pools.users.signing.current.privateKeyPem,
  ) => {
    const { createPrivateKey } = await import('node:crypto');
    const now = Math.floor(clock.now().getTime() / 1000);
    return new SignJWT({
      sid,
      idp: 'line',
      amr: ['fed'],
      token_use: 'access',
      iss: auth.pools.users.issuer,
      aud: auth.pools.users.audience,
      sub: 'line:U123',
      iat: now,
      exp: now + 600,
      ...claims,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'users-test-1', typ: 'at+jwt', ...header })
      .sign(createPrivateKey(key));
  };

  it('issues EdDSA tokens with per-pool iss, aud and kid, and verifies them', async () => {
    const { token, expiresIn } = await issuer.accessToken('users', {
      subject: 'google:1234',
      sessionId: sid,
      amr: ['fed'],
    });
    expect(expiresIn).toBe(auth.accessTokenTtlSeconds);
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      iss: authTokenIssuer('test', 'users'),
      aud: AUTH_TOKEN_AUDIENCES.users,
      sub: 'google:1234',
      sid,
      idp: 'google',
      amr: ['fed'],
      token_use: 'access',
    });
    await expect(verifier.verify(token)).resolves.toEqual({
      pool: 'users',
      sub: 'google:1234',
      tokenUse: 'access',
      email: null,
      name: null,
      issuer: 'shotx',
      amr: ['fed'],
      sessionId: sid,
    });
    const admin = await issuer.accessToken('admins', {
      subject: 'admin:0199b2a0-0000-7000-8000-000000000001',
      sessionId: sid,
      amr: ['pwd', 'otp', 'mfa'],
    });
    expect(decodeJwt(admin.token)).toMatchObject({
      iss: 'urn:shotx:test:auth:admins',
      aud: 'shotx-admin',
    });
    await expect(verifier.verify(admin.token)).resolves.toMatchObject({ pool: 'admins' });
  });

  it('never issues an admins token without pwd + otp, or for a subject of another pool', async () => {
    const subject = 'admin:0199b2a0-0000-7000-8000-000000000001';
    for (const amr of [['pwd'], ['otp'], ['fed'], ['dev']] as const) {
      await expect(issuer.accessToken('admins', { subject, sessionId: sid, amr })).rejects.toThrow(
        /required amr/,
      );
    }
    await expect(
      issuer.accessToken('admins', { subject: 'line:U1', sessionId: sid, amr: ['pwd', 'otp'] }),
    ).rejects.toThrow(/another pool/);
    await expect(
      issuer.accessToken('users', { subject, sessionId: sid, amr: ['fed'] }),
    ).rejects.toThrow(/another pool/);
    // Dev-login subjects only with AUTH_PROVIDER=local.
    await expect(
      issuer.accessToken('users', { subject: 'local:a@b.co', sessionId: sid, amr: ['dev'] }),
    ).rejects.toThrow(/development-login/);
  });

  it('rejects forged, foreign, expired and mistyped tokens', async () => {
    const otherKey = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const now = Math.floor(clock.now().getTime() / 1000);
    const bad = [
      await forge({}, {}, otherKey), // wrong key, right kid
      await forge({}, { kid: 'unknown' }),
      await forge({}, { kid: 'admins-test-1' }), // users key under the admins kid
      await forge({}, { typ: 'JWT' }),
      await forge({ iss: authTokenIssuer('prod', 'users') }),
      await forge({ aud: 'shotx-admin' }),
      await forge({ exp: now - 1 }),
      await forge({ token_use: 'id' }),
      await forge({ sub: 'google:1', idp: 'line' }), // prefix must match idp
      await forge({ sub: 'admin:0199b2a0-0000-7000-8000-000000000001', idp: 'admin' }),
      await forge({ sub: 'local:a@b.co', idp: 'local', amr: ['dev'] }), // dev login is off
      'not-a-jwt',
    ];
    for (const token of bad) {
      await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('accepts the previous key during a rotation, per pool', async () => {
    const oldKey = ed25519PrivateKeyBase64();
    const rotatedEnv = shotxEnv({
      AUTH_USERS_PREVIOUS_PUBLIC_KEY: ed25519PublicKeyBase64(oldKey),
      AUTH_USERS_PREVIOUS_KEY_ID: 'users-test-0',
    });
    const rotated = testConfig(rotatedEnv).shotxAuth;
    if (rotated === null) throw new Error('no config');
    const v = new ShotxTokenVerifier('test', rotated, clock);
    const oldPem = `-----BEGIN PRIVATE KEY-----\n${oldKey}\n-----END PRIVATE KEY-----\n`;
    await expect(v.verify(await forge({}, { kid: 'users-test-0' }, oldPem))).resolves.toMatchObject(
      { pool: 'users' },
    );
    // Without the previous key configured, the old kid is unknown.
    await expect(
      verifier.verify(await forge({}, { kid: 'users-test-0' }, oldPem)),
    ).rejects.toThrow();
  });

  it('passes an admins token short of otp on to the guard (MFA_REQUIRED there)', async () => {
    const { createPrivateKey } = await import('node:crypto');
    const now = Math.floor(clock.now().getTime() / 1000);
    const admins = auth.pools.admins;
    if (admins === null) throw new Error('no admins pool');
    const token = await new SignJWT({
      sid,
      idp: 'admin',
      amr: ['pwd'],
      token_use: 'access',
      sub: 'admin:0199b2a0-0000-7000-8000-000000000001',
      iss: admins.issuer,
      aud: admins.audience,
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'admins-test-1', typ: 'at+jwt' })
      .sign(createPrivateKey(admins.signing.current.privateKeyPem));
    const identity = await verifier.verify(token);
    expect(identity).toMatchObject({ pool: 'admins', amr: ['pwd'], issuer: 'shotx' });

    const guard = new AdminGuard(
      { verify: () => Promise.resolve(identity) } satisfies TokenVerifier,
      {} as Db,
      clock,
    );
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });

    const usersToken = await forge({});
    const usersGuard = new AdminGuard(verifier, {} as Db, clock);
    const usersContext = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${usersToken}` } }),
      }),
    } as unknown as ExecutionContext;
    await expect(usersGuard.canActivate(usersContext)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('derives amr from the subject', () => {
    expect(amrForSubject('line:U1')).toEqual(['fed']);
    expect(amrForSubject('google:1')).toEqual(['fed']);
    expect(amrForSubject('local:a@b.co')).toEqual(['dev']);
    expect(amrForSubject('admin:0199b2a0-0000-7000-8000-000000000001')).toEqual([
      'pwd',
      'otp',
      'mfa',
    ]);
    expect(() => amrForSubject('cognito-raw-sub')).toThrow(RangeError);
  });

  it('local mode issues dev-login tokens of the users pool', async () => {
    const local = testConfig(localAuthEnv()).shotxAuth;
    if (local === null) throw new Error('no config');
    const i = new ShotxTokenIssuer('local', local, clock);
    const v = new ShotxTokenVerifier('local', local, clock);
    const { token } = await i.accessToken('users', {
      subject: 'local:a@b.co',
      sessionId: sid,
      amr: ['dev'],
    });
    await expect(v.verify(token)).resolves.toMatchObject({ pool: 'users', sub: 'local:a@b.co' });
    // A local-stage token never verifies on another stage (issuer differs).
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('client address (ADR 0008 section 1)', () => {
  const req = (headers: Record<string, string>, remote = '172.18.0.5') =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as Request;
  const trust = clientIpTrust({
    bffKeys: { users: { key: TEST_BFF_KEY }, admins: { key: TEST_ADMIN_BFF_KEY } },
    trustedProxies: { addresses: ['172.18.0.0/16'] },
  });
  const noProxy = { ...trust, proxies: { addresses: [] } };

  it('trusts x-shotx-client-ip only with the valid BFF key', () => {
    const withKey = { 'x-shotx-bff-key': TEST_BFF_KEY, 'x-shotx-client-ip': '203.0.113.7' };
    expect(clientIp(req(withKey, '10.9.0.3'), trust)).toBe('203.0.113.7');
    expect(
      clientIp(req({ ...withKey, 'x-shotx-client-ip': '2001:db8::7' }, '10.9.0.3'), trust),
    ).toBe('2001:db8::7');
    expect(
      clientIp(req({ ...withKey, 'x-shotx-client-ip': '::ffff:203.0.113.8' }, '10.9.0.3'), trust),
    ).toBe('203.0.113.8');
    // Through the public proxy (internet traffic) the BFF headers are ignored, key or not.
    expect(clientIp(req({ ...withKey, 'x-forwarded-for': '198.51.100.9' }), trust)).toBe(
      '198.51.100.9',
    );
    expect(hasValidBffKey(req(withKey), trust)).toBeNull();
    expect(hasValidBffKey(req(withKey, '10.9.0.3'), trust)).toBe('users');
    // The admin app's key names the admins pool, and is trusted for the client IP as well.
    const adminKey = { ...withKey, 'x-shotx-bff-key': TEST_ADMIN_BFF_KEY };
    expect(hasValidBffKey(req(adminKey, '10.9.0.3'), trust)).toBe('admins');
    expect(clientIp(req(adminKey, '10.9.0.3'), trust)).toBe('203.0.113.7');
    expect(hasValidBffKey(req({}, '10.9.0.3'), trust)).toBeNull();
    // Spoofed without a key, or with a wrong key: ignored (socket peer, no XFF).
    expect(clientIp(req({ 'x-shotx-client-ip': '203.0.113.7' }, '10.9.0.3'), trust)).toBe(
      '10.9.0.3',
    );
    expect(
      clientIp(req({ ...withKey, 'x-shotx-bff-key': `${TEST_BFF_KEY}x` }, '10.9.0.3'), trust),
    ).toBe('10.9.0.3');
    // No key configured: never trusted.
    expect(
      clientIp(req(withKey, '10.9.0.3'), { ...trust, bffKeys: { users: null, admins: null } }),
    ).toBe('10.9.0.3');
    // A value that isn't an address: the next source.
    expect(clientIp(req({ ...withKey, 'x-shotx-client-ip': 'evil' }, '10.9.0.3'), trust)).toBe(
      '10.9.0.3',
    );
  });

  it('reads X-Forwarded-For (rightmost) only from a trusted proxy peer', () => {
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.4' }), trust)).toBe('198.51.100.4');
    // A client-sent copy that got through: the rightmost entry is the proxy's.
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.4' }), trust)).toBe(
      '198.51.100.4',
    );
    // IPv4-mapped IPv6 peer (dual-stack socket) still matches the IPv4 range.
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.4' }, '::ffff:172.18.0.9'), trust)).toBe(
      '198.51.100.4',
    );
    // Untrusted peer: XFF ignored; mapped peers come back as IPv4.
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.4' }, '::ffff:10.0.0.9'), trust)).toBe(
      '10.0.0.9',
    );
    expect(clientIp(req({ 'x-forwarded-for': 'garbage' }), trust)).toBe('172.18.0.5');
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.4' }), noProxy)).toBe('172.18.0.5');
  });

  it('keeps CloudFront markers on AWS (no trusted proxy) and ignores them behind the proxy', () => {
    const cf = cloudFrontOriginHeaders('203.0.113.10:443');
    expect(clientIp(req(cf, '10.0.0.9'), noProxy)).toBe('203.0.113.10');
    expect(clientIp(req({ ...cf, 'x-forwarded-for': '198.51.100.4' }), trust)).toBe('198.51.100.4');
    // BFF header first, CloudFront second.
    const both = { ...cf, 'x-shotx-bff-key': TEST_BFF_KEY, 'x-shotx-client-ip': '203.0.113.99' };
    expect(clientIp(req(both, '10.0.0.9'), noProxy)).toBe('203.0.113.99');
  });

  it('compares secrets in constant time and never matches empty or missing values', () => {
    expect(secretMatches(TEST_BFF_KEY, TEST_BFF_KEY)).toBe(true);
    expect(secretMatches('short', TEST_BFF_KEY)).toBe(false);
    expect(secretMatches(undefined, TEST_BFF_KEY)).toBe(false);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches(TEST_BFF_KEY, null)).toBe(false);
  });
});

describe('auth helpers', () => {
  it('builds the PKCE S256 challenge (RFC 7636 appendix B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('keys admin accounts by an HMAC of the normalized email, never the email', () => {
    const secret = 'x'.repeat(32);
    expect(normalizeAdminEmail(' Admin@Example.COM ')).toBe('admin@example.com');
    expect(adminAccountKey(secret, 'Admin@Example.com')).toBe(
      adminAccountKey(secret, 'admin@example.com '),
    );
    expect(adminAccountKey(secret, 'a@example.com')).toMatch(/^v1:[A-Za-z0-9_-]{43}$/);
    expect(adminAccountKey(secret, 'a@example.com')).not.toContain('example');
  });

  it('keeps a rotated successor for the grace window, readable with the old token only', async () => {
    const clock = new TestClock();
    const store = new MemoryKeyValueStore(() => clock.now().getTime());
    const grace = storeRefreshGrace(store, 10);
    await grace.save('old-token', 'new-token');
    const [key] = store.keys();
    expect(key).toMatch(/^auth:refresh-grace:[0-9a-f]{64}$/);
    expect(await store.get(key ?? '')).not.toContain('new-token');
    expect(await grace.load('old-token')).toBe('new-token');
    expect(await grace.load('other-token')).toBeNull();
    clock.advance(11_000);
    expect(await grace.load('old-token')).toBeNull();
  });

  it('peeks rate-limit windows without counting, and takes one-time values', async () => {
    const clock = new TestClock();
    const limiter = new MemoryRateLimiter(() => clock.now().getTime());
    expect((await limiter.peek('k', 2, 60)).allowed).toBe(true);
    await limiter.hit('k', 2, 60);
    expect((await limiter.peek('k', 2, 60)).allowed).toBe(true);
    await limiter.hit('k', 2, 60);
    expect(await limiter.peek('k', 2, 60)).toMatchObject({ allowed: false });
    expect((await limiter.peek('k', 3, 60)).allowed).toBe(true);
    clock.advance(61_000);
    expect((await limiter.peek('k', 2, 60)).allowed).toBe(true);

    const store = new MemoryKeyValueStore(() => clock.now().getTime());
    await store.setWithTtl('once', 'v', 60);
    expect(await store.take('once')).toBe('v');
    expect(await store.take('once')).toBeNull();
  });
});

describe('BullMQ job options (same as the worker)', () => {
  it('maps the shared queue settings', () => {
    const config = loadQueueBackendConfig({ QUEUE_BACKEND: 'bullmq', APP_STAGE: 'test' }, [
      'faces',
      'zip',
    ]);
    if (config.backend !== 'bullmq') throw new Error('expected bullmq');
    expect(bullMqJobOptions(config.queues.zip)).toMatchObject({
      attempts: BULLMQ_QUEUE_DEFAULTS.zip.attempts,
      backoff: { type: 'exponential', delay: BULLMQ_QUEUE_DEFAULTS.zip.backoffBaseSeconds * 1000 },
      removeOnComplete: { count: BULLMQ_QUEUE_DEFAULTS.zip.completedRetentionCount },
      removeOnFail: { count: BULLMQ_QUEUE_DEFAULTS.zip.failedRetentionCount },
    });
    expect(bullMqJobOptions(config.queues.zip)).not.toHaveProperty('jobId');
    expect(bullMqJobOptions(config.queues.faces)).not.toHaveProperty('jobId');
    const options = bullMqQueueOptions(config.queues.faces, config.prefix);
    expect(options).toMatchObject({
      prefix: 'shotx:test:bull',
      skipVersionCheck: true,
      streams: { events: { maxLen: BULLMQ_QUEUE_DEFAULTS.faces.eventsMaxLen } },
    });
  });

  it('uses the static OIDC metadata over HTTPS only', () => {
    for (const meta of Object.values(OIDC_PROVIDER_METADATA)) {
      expect(new URL(meta.tokenEndpoint).protocol).toBe('https:');
      expect(new URL(meta.authorizationEndpoint).protocol).toBe('https:');
    }
  });
});
