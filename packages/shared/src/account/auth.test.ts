import { describe, expect, it } from 'vitest';
import { OIDC_PROVIDERS } from '../domain';
import {
  adminAccountSubject,
  AUTH_SUBJECT_PROVIDER_POOL,
  authSubject,
  isAuthSubjectInPool,
  isPasswordAccountSubject,
  localDevSubject,
  PASSWORD_ACCOUNT_PROVIDERS,
  parseAuthSubject,
  passwordAccountSubject,
} from './auth-subject';
import { OIDC_PROVIDER_METADATA } from './oidc';
import {
  accessTokenClaimsSchemaFor,
  ADMIN_REQUIRED_AMR,
  AUTH_TOKEN_AUDIENCES,
  authTokenIssuer,
  hasRequiredAmr,
  opaqueTokenSchema,
  PASSWORD_CHANGE_CLAIM,
  REFRESH_TOKEN_HASH_PATTERN,
} from './tokens';

const uuid = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';

describe('auth subjects', () => {
  it('builds and parses prefixed subjects', () => {
    expect(authSubject('line', 'U4af4980629')).toBe('line:U4af4980629');
    expect(authSubject('google', '110169484474386276334')).toBe('google:110169484474386276334');
    expect(authSubject('admin', uuid)).toBe(`admin:${uuid}`);
    expect(localDevSubject('  Somchai@Example.COM ')).toBe('local:somchai@example.com');
    expect(parseAuthSubject('line:U4af4980629')).toEqual({ provider: 'line', id: 'U4af4980629' });
    expect(parseAuthSubject('local:a:b')).toEqual({ provider: 'local', id: 'a:b' });
  });

  it('treats unprefixed values as legacy Cognito subs', () => {
    expect(parseAuthSubject(uuid)).toEqual({ provider: 'cognito', id: uuid });
  });

  it('rejects bad ids, unknown prefixes and over-long subjects', () => {
    expect(() => authSubject('line', '')).toThrow(RangeError);
    expect(() => authSubject('line', 'has space')).toThrow(RangeError);
    expect(() => authSubject('line', 'ไทย')).toThrow(RangeError);
    expect(() => authSubject('okta' as never, 'x')).toThrow(RangeError);
    expect(() => authSubject('google', '1'.repeat(250))).toThrow(RangeError);
    for (const bad of ['', 'okta:123', 'line:', 'line:a b', 'x'.repeat(256), 'a\u0000b']) {
      expect(parseAuthSubject(bad), bad).toBeNull();
    }
  });

  it('keeps each prefix in its pool; local and federated subjects are never admins', () => {
    expect(AUTH_SUBJECT_PROVIDER_POOL).toEqual({
      line: 'users',
      google: 'users',
      local: 'users',
      admin: 'admins',
      password: 'users',
    });
    expect(isAuthSubjectInPool('line:U1', 'users')).toBe(true);
    expect(isAuthSubjectInPool('local:a@example.com', 'admins')).toBe(false);
    expect(isAuthSubjectInPool('google:1', 'admins')).toBe(false);
    expect(isAuthSubjectInPool(`admin:${uuid}`, 'users')).toBe(false);
    expect(isAuthSubjectInPool(`admin:${uuid}`, 'admins')).toBe(true);
    expect(isAuthSubjectInPool(uuid, 'admins')).toBe(true);
    expect(isAuthSubjectInPool('okta:1', 'users')).toBe(false);
    expect(isAuthSubjectInPool(`password:${uuid}`, 'users')).toBe(true);
    expect(isAuthSubjectInPool(`password:${uuid}`, 'admins')).toBe(false);
  });

  it('builds password-account subjects from the users.id (ADR 0010)', () => {
    const upper = uuid.toUpperCase();
    expect(passwordAccountSubject(upper)).toBe(`password:${uuid.toLowerCase()}`);
    expect(adminAccountSubject(uuid)).toBe(`admin:${uuid.toLowerCase()}`);
    for (const bad of ['', 'not-a-uuid', `${uuid}x`, 'line:U1']) {
      expect(() => passwordAccountSubject(bad), bad).toThrow(RangeError);
      expect(() => adminAccountSubject(bad), bad).toThrow(RangeError);
    }
    expect(PASSWORD_ACCOUNT_PROVIDERS).toEqual(['admin', 'password']);
    expect(isPasswordAccountSubject(`password:${uuid}`)).toBe(true);
    expect(isPasswordAccountSubject(`admin:${uuid}`)).toBe(true);
    for (const other of [`line:${uuid}`, `google:1`, `local:a@example.com`, uuid, '']) {
      expect(isPasswordAccountSubject(other), other).toBe(false);
    }
    // Never collides with a federated subject: the prefix is not an OIDC provider.
    expect(OIDC_PROVIDERS as readonly string[]).not.toContain('password');
  });
});

describe('access token claims', () => {
  const now = 1_793_000_000;
  const users = {
    iss: 'urn:shotx:prod:auth:users',
    aud: 'shotx-web',
    sub: 'line:U1',
    iat: now,
    exp: now + 900,
    sid: uuid,
    idp: 'line',
    amr: ['fed'],
    token_use: 'access',
  };
  const admins = {
    ...users,
    iss: 'urn:shotx:prod:auth:admins',
    aud: 'shotx-admin',
    sub: `admin:${uuid}`,
    idp: 'admin',
    amr: ['pwd', 'otp', 'mfa'],
  };

  it('issuer and audience per pool and stage', () => {
    expect(authTokenIssuer('prod', 'admins')).toBe('urn:shotx:prod:auth:admins');
    expect(AUTH_TOKEN_AUDIENCES).toEqual({ users: 'shotx-web', admins: 'shotx-admin' });
    expect(() => authTokenIssuer('Prod', 'users')).toThrow(RangeError);
  });

  it('accepts valid tokens of each pool', () => {
    expect(accessTokenClaimsSchemaFor('prod', 'users').parse(users)).toEqual(users);
    expect(accessTokenClaimsSchemaFor('prod', 'admins').parse(admins)).toEqual(admins);
  });

  it('requires pwd and otp in admin tokens', () => {
    expect(ADMIN_REQUIRED_AMR).toEqual(['pwd', 'otp']);
    expect(hasRequiredAmr('admins', ['pwd'])).toBe(false);
    expect(hasRequiredAmr('admins', ['pwd', 'otp'])).toBe(true);
    expect(hasRequiredAmr('users', ['fed'])).toBe(true);
    const schema = accessTokenClaimsSchemaFor('prod', 'admins');
    expect(schema.safeParse({ ...admins, amr: ['pwd'] }).success).toBe(false);
    expect(schema.safeParse({ ...admins, amr: ['pwd', 'mfa'] }).success).toBe(false);
  });

  it('carries pwd_change only on photographer password sessions (ADR 0010)', () => {
    expect(PASSWORD_CHANGE_CLAIM).toBe('pwd_change');
    const usersSchema = accessTokenClaimsSchemaFor('prod', 'users');
    const photographer = { ...users, sub: `password:${uuid}`, idp: 'password', amr: ['pwd'] };
    expect(usersSchema.parse(photographer)).toEqual(photographer);
    const restricted = { ...photographer, pwd_change: true };
    expect(usersSchema.parse(restricted)).toEqual(restricted);
    expect(usersSchema.safeParse({ ...photographer, pwd_change: false }).success).toBe(false);
    expect(usersSchema.safeParse({ ...users, pwd_change: true }).success).toBe(false);
    expect(
      accessTokenClaimsSchemaFor('prod', 'admins').safeParse({ ...admins, pwd_change: true })
        .success,
    ).toBe(false);
    // A password subject never verifies as an admins token.
    expect(
      accessTokenClaimsSchemaFor('prod', 'admins').safeParse({
        ...photographer,
        ...admins,
        sub: `password:${uuid}`,
        idp: 'password',
      }).success,
    ).toBe(false);
  });

  it('rejects tokens of another pool, stage, audience or provider', () => {
    const usersSchema = accessTokenClaimsSchemaFor('prod', 'users');
    const adminsSchema = accessTokenClaimsSchemaFor('prod', 'admins');
    expect(adminsSchema.safeParse(users).success).toBe(false);
    expect(usersSchema.safeParse(admins).success).toBe(false);
    expect(accessTokenClaimsSchemaFor('staging', 'users').safeParse(users).success).toBe(false);
    expect(usersSchema.safeParse({ ...users, aud: 'shotx-admin' }).success).toBe(false);
    expect(usersSchema.safeParse({ ...users, idp: 'google' }).success).toBe(false);
    // A dev-login subject in an admins token never passes.
    expect(
      adminsSchema.safeParse({ ...admins, sub: 'local:a@example.com', idp: 'local' }).success,
    ).toBe(false);
    expect(usersSchema.safeParse({ ...users, exp: now }).success).toBe(false);
    expect(usersSchema.safeParse({ ...users, token_use: 'id' }).success).toBe(false);
    expect(usersSchema.safeParse({ ...users, amr: [] }).success).toBe(false);
  });

  it('opaque tokens and refresh hashes', () => {
    expect(opaqueTokenSchema.safeParse('a'.repeat(43)).success).toBe(true);
    expect(opaqueTokenSchema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(opaqueTokenSchema.safeParse(`${'a'.repeat(42)}=`).success).toBe(false);
    expect(REFRESH_TOKEN_HASH_PATTERN.test('0'.repeat(64))).toBe(true);
    expect(REFRESH_TOKEN_HASH_PATTERN.test('A'.repeat(64))).toBe(false);
  });
});

describe('OIDC provider metadata', () => {
  it('uses https endpoints and asks for openid', () => {
    for (const metadata of Object.values(OIDC_PROVIDER_METADATA)) {
      for (const url of [
        metadata.authorizationEndpoint,
        metadata.tokenEndpoint,
        metadata.jwksUri,
      ]) {
        expect(url.startsWith('https://')).toBe(true);
      }
      expect(metadata.scopes).toContain('openid');
    }
  });
});
