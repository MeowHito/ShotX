import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_DETAILS_SCHEMAS, ERROR_HTTP_STATUS, ErrorCode } from '../errors';
import {
  adminLoginBodySchema,
  adminMfaBodySchema,
  authProvidersResponseSchema,
  authTokenResponseSchema,
  bffClientIpSchema,
  devLoginBodySchema,
  oidcCallbackBodySchema,
  oidcProviderParamsSchema,
  oidcStartBodySchema,
  refreshBodySchema,
  viewerLoginAvailable,
} from './auth';
import { ALL_ROUTES, apiPath, AUTH_ROUTES, SHARE_ROUTES } from './routes';

const token = 'A'.repeat(43);

describe('auth route schemas', () => {
  it('OIDC start and callback', () => {
    expect(oidcProviderParamsSchema.parse({ provider: 'line' })).toEqual({ provider: 'line' });
    expect(oidcProviderParamsSchema.safeParse({ provider: 'facebook' }).success).toBe(false);
    expect(
      oidcStartBodySchema.safeParse({ redirectUri: 'https://photos.example.com/auth/callback' })
        .success,
    ).toBe(true);
    for (const redirectUri of [
      'javascript:alert(1)',
      'not a url',
      `https://x.com/${'a'.repeat(2048)}`,
    ]) {
      expect(oidcStartBodySchema.safeParse({ redirectUri }).success, redirectUri).toBe(false);
    }
    expect(oidcStartBodySchema.safeParse({ redirectUri: 'https://a.com', extra: 1 }).success).toBe(
      false,
    );
    expect(oidcCallbackBodySchema.safeParse({ state: token, code: 'abc' }).success).toBe(true);
    expect(oidcCallbackBodySchema.safeParse({ state: 'short', code: 'abc' }).success).toBe(false);
    expect(oidcCallbackBodySchema.safeParse({ state: token, code: '' }).success).toBe(false);
  });

  it('dev login, refresh and admin sign-in bodies', () => {
    expect(devLoginBodySchema.parse({ email: 'a@example.com', name: ' สมชาย ' })).toEqual({
      email: 'a@example.com',
      name: 'สมชาย',
    });
    expect(devLoginBodySchema.safeParse({ email: 'nope', name: 'x' }).success).toBe(false);
    expect(refreshBodySchema.safeParse({ refreshToken: token, pool: 'admins' }).success).toBe(true);
    expect(refreshBodySchema.safeParse({ refreshToken: token }).success).toBe(false);
    expect(
      adminLoginBodySchema.safeParse({ email: 'admin@example.com', password: 'x'.repeat(1025) })
        .success,
    ).toBe(false);
    for (const code of ['123456', '12345678']) {
      expect(adminMfaBodySchema.safeParse({ challengeId: token, code }).success).toBe(true);
    }
    for (const code of ['12345', '1234567', '12345a', ' 123456']) {
      expect(adminMfaBodySchema.safeParse({ challengeId: token, code }).success, code).toBe(false);
    }
  });

  it('token response', () => {
    expect(
      authTokenResponseSchema.safeParse({
        accessToken: 'a.b.c',
        refreshToken: token,
        expiresIn: 900,
        refreshExpiresIn: 2_592_000,
        user: { email: null, name: 'สมชาย' },
      }).success,
    ).toBe(true);
  });

  it('client IP header values', () => {
    expect(bffClientIpSchema.safeParse('203.0.113.10').success).toBe(true);
    expect(bffClientIpSchema.safeParse('2001:db8::1').success).toBe(true);
    expect(bffClientIpSchema.safeParse('203.0.113.10, 10.0.0.1').success).toBe(false);
  });
});

describe('AUTH_ROUTES', () => {
  it('are bff routes under /auth, all in ALL_ROUTES', () => {
    for (const route of Object.values(AUTH_ROUTES)) {
      expect(route.auth).toBe('bff');
      expect(route.path.startsWith('/auth/')).toBe(true);
      expect(ALL_ROUTES).toContain(route);
    }
    expect(apiPath(AUTH_ROUTES.oidcStart, { provider: 'google' })).toBe(
      '/api/auth/oidc/google/start',
    );
  });

  it('list the sign-in error codes', () => {
    expect(AUTH_ROUTES.oidcCallback.errors).toEqual(
      expect.arrayContaining([ErrorCode.LOGIN_STATE_INVALID, ErrorCode.IDENTITY_PROVIDER_ERROR]),
    );
    expect(AUTH_ROUTES.refresh.errors).toEqual(
      expect.arrayContaining([ErrorCode.REFRESH_TOKEN_INVALID, ErrorCode.REFRESH_TOKEN_REUSED]),
    );
    expect(AUTH_ROUTES.adminLogin.errors).toContain(ErrorCode.INVALID_CREDENTIALS);
    expect(AUTH_ROUTES.adminMfa.errors).toContain(ErrorCode.MFA_INVALID);
    expect(AUTH_ROUTES.logout.status).toBe(204);
  });
});

describe('auth error codes', () => {
  it('have statuses, and details schemas where they carry details', () => {
    for (const code of [
      'AUTH_PROVIDER_UNAVAILABLE',
      'LOGIN_STATE_INVALID',
      'IDENTITY_PROVIDER_ERROR',
      'INVALID_CREDENTIALS',
      'MFA_INVALID',
      'MFA_REQUIRED',
      'REFRESH_TOKEN_INVALID',
      'REFRESH_TOKEN_REUSED',
    ] as const) {
      expect(ERROR_CODES).toContain(code);
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(
      ERROR_DETAILS_SCHEMAS.IDENTITY_PROVIDER_ERROR.safeParse({
        provider: 'line',
        reason: 'id_token_invalid',
      }).success,
    ).toBe(true);
    expect(
      ERROR_DETAILS_SCHEMAS.AUTH_PROVIDER_UNAVAILABLE.safeParse({ provider: 'google' }).success,
    ).toBe(true);
  });
});

describe('no viewer login provider (launch decision 2026-11-11)', () => {
  it('GET /auth/providers allows an empty OIDC list, in order and without repeats', () => {
    expect(
      authProvidersResponseSchema.parse({
        oidc: [],
        devLogin: false,
        adminLogin: true,
        adminMfaMode: 'off',
      }),
    ).toEqual({ oidc: [], devLogin: false, adminLogin: true, adminMfaMode: 'off' });
    expect(
      authProvidersResponseSchema.safeParse({
        oidc: ['line', 'google'],
        devLogin: false,
        adminLogin: true,
        adminMfaMode: null,
      }).success,
    ).toBe(true);
    expect(
      authProvidersResponseSchema.safeParse({
        oidc: ['line', 'line'],
        devLogin: false,
        adminLogin: true,
        adminMfaMode: null,
      }).success,
    ).toBe(false);
    expect(AUTH_ROUTES.providers.response).toBe(authProvidersResponseSchema);
  });

  it('a viewer can sign in only with an OIDC provider or the dev login', () => {
    expect(viewerLoginAvailable({ oidc: [], devLogin: false })).toBe(false);
    expect(viewerLoginAvailable({ oidc: ['line'], devLogin: false })).toBe(true);
    expect(viewerLoginAvailable({ oidc: [], devLogin: true })).toBe(true);
  });

  it('share create and update declare LOGIN_PROVIDER_UNAVAILABLE (409, no details)', () => {
    expect(ErrorCode.LOGIN_PROVIDER_UNAVAILABLE).toBe('LOGIN_PROVIDER_UNAVAILABLE');
    expect(ERROR_HTTP_STATUS.LOGIN_PROVIDER_UNAVAILABLE).toBe(409);
    expect(Object.keys(ERROR_DETAILS_SCHEMAS)).not.toContain('LOGIN_PROVIDER_UNAVAILABLE');
    expect(SHARE_ROUTES.create.errors).toContain(ErrorCode.LOGIN_PROVIDER_UNAVAILABLE);
    expect(SHARE_ROUTES.update.errors).toContain(ErrorCode.LOGIN_PROVIDER_UNAVAILABLE);
    // Only the routes that can set require_login.
    const declaring = ALL_ROUTES.filter((route) =>
      (route.errors as readonly string[]).includes(ErrorCode.LOGIN_PROVIDER_UNAVAILABLE),
    )
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(declaring).toEqual(['PATCH /shares/:id', 'POST /shares']);
  });
});
