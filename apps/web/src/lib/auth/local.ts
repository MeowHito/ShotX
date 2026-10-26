import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { LOCAL_AUTH_AUDIENCE, LOCAL_AUTH_ISSUER } from '@shotx/shared';
import { z } from 'zod';
import { AUTH_PATHS } from './handlers';
import { base64UrlEncode, codeChallenge } from './pkce';
import { type AuthProvider, AuthProviderError, type AuthTokens } from './provider';
import { decodeJsonCookie, encodeJsonCookie } from './session';

/**
 * AUTH_PROVIDER=local: a development-only stand-in for the Cognito Hosted UI (the config loader
 * refuses it outside APP_STAGE=local). The browser picks an email on /auth/local, which redirects
 * to the normal callback with a code bound to the PKCE challenge; the code exchange mints HS256
 * tokens with LOCAL_AUTH_SECRET that the API verifies with the same secret. The rest of the flow
 * (state, PKCE, cookies, refresh, logout) is the same code path as Cognito.
 */

/** The stand-in Hosted UI page (src/app/auth/local). */
export const LOCAL_AUTH_PAGE_PATH = '/auth/local';
/** Its form target, which issues the code (src/app/auth/local/authorize). */
export const LOCAL_AUTH_AUTHORIZE_PATH = '/auth/local/authorize';

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 5 * 60;

export const localIdentitySchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(200),
});
export type LocalIdentity = z.output<typeof localIdentitySchema>;

// `typ` keeps a code from being replayed as a refresh token and the other way round.
const codeSchema = localIdentitySchema.extend({
  typ: z.literal('code'),
  challenge: z.string().min(43),
  exp: z.number().int(),
});
const refreshSchema = localIdentitySchema.extend({
  typ: z.literal('refresh'),
  exp: z.number().int(),
});

const sign = (secret: string, data: string) =>
  base64UrlEncode(createHmac('sha256', secret).update(data).digest());

function signedValue(secret: string, value: unknown): string {
  const body = encodeJsonCookie(value);
  return `${body}.${sign(secret, body)}`;
}

function verifySigned(secret: string, value: string): unknown {
  const [body, mac, ...rest] = value.split('.');
  if (body === undefined || mac === undefined || rest.length > 0) return undefined;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return decodeJsonCookie(body);
}

/** A stable `sub` per email, shaped like a Cognito sub (UUID). */
export function localSub(email: string): string {
  const hex = createHash('sha256').update(`shotx-local:${email.toLowerCase()}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function jwt(secret: string, claims: Record<string, unknown>): string {
  const header = encodeJsonCookie({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJsonCookie(claims);
  return `${header}.${payload}.${sign(secret, `${header}.${payload}`)}`;
}

/** The code /auth/local/authorize hands to the callback: the identity, bound to the challenge. */
export function issueLocalCode(
  secret: string,
  identity: LocalIdentity,
  codeChallenge: string,
  now: number = Date.now(),
): string {
  return signedValue(secret, {
    ...identity,
    typ: 'code',
    challenge: codeChallenge,
    exp: Math.floor(now / 1000) + CODE_SECONDS,
  });
}

export function createLocalAuthProvider(config: {
  secret: string;
  publicBaseUrl: string;
  now?: () => number;
}): AuthProvider {
  const now = config.now ?? (() => Date.now());

  function tokens(identity: LocalIdentity): AuthTokens {
    const iat = Math.floor(now() / 1000);
    const base = {
      iss: LOCAL_AUTH_ISSUER,
      aud: LOCAL_AUTH_AUDIENCE,
      sub: localSub(identity.email),
      email: identity.email,
      email_verified: true,
      name: identity.name,
      iat,
      exp: iat + ACCESS_TOKEN_SECONDS,
    };
    return {
      accessToken: jwt(config.secret, { ...base, token_use: 'access' }),
      idToken: jwt(config.secret, { ...base, token_use: 'id' }),
      refreshToken: signedValue(config.secret, {
        ...identity,
        typ: 'refresh',
        exp: iat + REFRESH_TOKEN_SECONDS,
      }),
      expiresIn: ACCESS_TOKEN_SECONDS,
    };
  }

  return {
    authorizationUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(`${config.publicBaseUrl}${LOCAL_AUTH_PAGE_PATH}`);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('redirect_uri', redirectUri);
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier }) {
      const parsed = codeSchema.safeParse(verifySigned(config.secret, code));
      if (!parsed.success || parsed.data.exp < now() / 1000) {
        throw new AuthProviderError('Invalid code', 400);
      }
      if ((await codeChallenge(codeVerifier)) !== parsed.data.challenge)
        throw new AuthProviderError('PKCE mismatch', 400);
      return tokens({ email: parsed.data.email, name: parsed.data.name });
    },

    refresh(refreshToken) {
      const parsed = refreshSchema.safeParse(verifySigned(config.secret, refreshToken));
      if (!parsed.success || parsed.data.exp < now() / 1000) {
        return Promise.reject(new AuthProviderError('Invalid refresh token', 400));
      }
      return Promise.resolve(tokens({ email: parsed.data.email, name: parsed.data.name }));
    },

    async revoke() {
      // Nothing to revoke: the cookies are cleared by the caller.
    },

    logoutUrl(returnTo) {
      return returnTo;
    },
  };
}

/**
 * POST /auth/local/authorize (AUTH_PROVIDER=local only): issues a code for the identity typed on
 * /auth/local and returns to the callback, like the Hosted UI does. A form POST keeps the email
 * out of URLs and logs; the callback still checks `state` against the PKCE cookie.
 */
export async function handleLocalAuthorize(
  request: Request,
  config: { secret: string; publicBaseUrl: string } | null,
): Promise<Response> {
  if (config === null) return new Response(null, { status: 404 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const callback = `${config.publicBaseUrl}${AUTH_PATHS.callback}`;
  const state = field('state');
  const challenge = field('code_challenge');
  // Only ever back to our own callback (no open redirect).
  if (field('redirect_uri') !== callback || state === '' || challenge.length < 43) {
    return new Response(null, { status: 400 });
  }
  const identity = localIdentitySchema.safeParse({ email: field('email'), name: field('name') });
  const location = new URL(callback);
  if (identity.success) {
    location.searchParams.set('code', issueLocalCode(config.secret, identity.data, challenge));
  } else {
    location.searchParams.set('error', 'invalid_request');
  }
  location.searchParams.set('state', state);
  return new Response(null, {
    status: 303,
    headers: { location: location.toString(), 'cache-control': 'no-store' },
  });
}
