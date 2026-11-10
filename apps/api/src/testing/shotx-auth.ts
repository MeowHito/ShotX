import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { type Env, OIDC_PROVIDER_METADATA, type OidcProvider } from '@shotx/shared';
import {
  createLocalJWKSet,
  exportJWK,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';
import type { OidcDeps } from '../auth/oidc';

// Test settings and fakes of the API's own sign-in (AUTH_PROVIDER=shotx or local). No network:
// the LINE and Google token endpoints and Google's JWKS are served from memory.

/** A fresh Ed25519 private key as base64 DER (what AUTH_*_SIGNING_KEY accepts). */
export function ed25519PrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

/** The SPKI public key (base64 DER) of a base64 DER private key (AUTH_*_PREVIOUS_PUBLIC_KEY). */
export function ed25519PublicKeyBase64(privateKeyBase64: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
}

export const TEST_BFF_KEY = 'test-bff-key-0123456789abcdef0123456789';
/** AUTH_ADMIN_BFF_KEY of the tests: the admin app's key, distinct from web's TEST_BFF_KEY. */
export const TEST_ADMIN_BFF_KEY = 'test-admin-bff-key-fedcba9876543210fedcba';
export const TEST_LINE_CHANNEL_ID = '1234567890';
export const TEST_LINE_CHANNEL_SECRET = 'test-line-channel-secret-0123456789';
export const TEST_GOOGLE_CLIENT_ID = '1234567890-testclient.apps.googleusercontent.com';
export const TEST_GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
export const TEST_TOTP_KEY = randomBytes(32).toString('base64');

/**
 * The key the right app would send (BffKeyScope): the admin app's for admin sign-in steps and
 * admin routes and for admins-pool refresh/logout bodies, web's otherwise.
 */
export function bffKeyFor(path: string, body?: unknown): string {
  const pool = (body as { pool?: unknown } | undefined)?.pool;
  return path.startsWith('/api/auth/admin/') || path.startsWith('/api/admin/') || pool === 'admins'
    ? TEST_ADMIN_BFF_KEY
    : TEST_BFF_KEY;
}

/** Everything AUTH_PROVIDER=shotx (or local) needs. Keys are generated once per test process. */
export const TEST_SHOTX_AUTH_ENV: Env = {
  AUTH_BFF_KEY: TEST_BFF_KEY,
  AUTH_ADMIN_BFF_KEY: TEST_ADMIN_BFF_KEY,
  AUTH_USERS_SIGNING_KEY: ed25519PrivateKeyBase64(),
  AUTH_USERS_SIGNING_KEY_ID: 'users-test-1',
  AUTH_ADMINS_SIGNING_KEY: ed25519PrivateKeyBase64(),
  AUTH_ADMINS_SIGNING_KEY_ID: 'admins-test-1',
  LINE_LOGIN_CHANNEL_ID: TEST_LINE_CHANNEL_ID,
  LINE_LOGIN_CHANNEL_SECRET: TEST_LINE_CHANNEL_SECRET,
  GOOGLE_OAUTH_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: TEST_GOOGLE_CLIENT_SECRET,
  ADMIN_TOTP_ENCRYPTION_KEY: TEST_TOTP_KEY,
  // Off AWS there is no WAF: rate limits only (captcha tests switch on turnstile).
  CAPTCHA_PROVIDER: 'none',
  // Off AWS (AUTH_PROVIDER=shotx/local) Rekognition needs explicit keys (no task role).
  REKOGNITION_ACCESS_KEY_ID: 'AKIATESTREKOGNITION0',
  REKOGNITION_SECRET_ACCESS_KEY: 'test-rekognition-secret',
  // Off AWS the SDK must ignore endpoint_url from env and config files (ADR 0008 §1).
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
  // Cheap argon2id for tests (OWASP's lowest acceptable setting).
  SHARE_PASSWORD_ARGON2_MEMORY_KIB: '12288',
  SHARE_PASSWORD_ARGON2_TIME_COST: '3',
};

/** The env of a test API with the API's own sign-in on (`shotx` on stage `test`). */
export function shotxEnv(overrides: Env = {}): Env {
  return {
    ...TEST_SHOTX_AUTH_ENV,
    AUTH_PROVIDER: 'shotx',
    // Tests call the API directly (no reverse proxy).
    TRUSTED_PROXY_ADDRESSES: 'none',
    ...overrides,
  };
}

/** The env of a test API in local mode (dev login on). */
export function localAuthEnv(overrides: Env = {}): Env {
  return {
    ...TEST_SHOTX_AUTH_ENV,
    AUTH_PROVIDER: 'local',
    APP_STAGE: 'local',
    NODE_ENV: 'development',
    ...overrides,
  };
}

interface PendingCode {
  provider: OidcProvider;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  claims: JWTPayload;
}

/** What one token-endpoint call should do instead of answering normally. */
export type TokenEndpointFault =
  | { kind: 'status'; status: number }
  | { kind: 'network' }
  | { kind: 'no-id-token' }
  /** Sign the ID token with these overrides (claims) or another key. */
  | { kind: 'claims'; claims: JWTPayload }
  | { kind: 'wrong-key' };

/**
 * LINE and Google as the API sees them: an authorization step (what the browser does at the
 * provider) issues a code bound to the PKCE challenge; the token endpoint checks the client,
 * redirect URI and code verifier, and answers an ID token signed like the real provider (Google:
 * RS256 with a key from the fake JWKS; LINE: HS256 with the channel secret).
 */
export class FakeOidcProviders {
  private readonly codes = new Map<string, PendingCode>();
  /** Token-endpoint requests seen (form fields), for assertions. */
  readonly tokenRequests: { url: string; form: URLSearchParams; signal: boolean }[] = [];
  /** Applied to the next token-endpoint call only. */
  nextFault: TokenEndpointFault | null = null;

  private constructor(
    private readonly google: { privateKey: KeyObject; jwk: JWK },
    private readonly otherGoogleKey: KeyObject,
    private readonly now: () => Date,
  ) {}

  /** `now`: the clock ID tokens are issued on (the API's test clock). */
  static async create(now: () => Date = () => new Date()): Promise<FakeOidcProviders> {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'google-test-key',
      alg: 'RS256',
      use: 'sig',
    };
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    return new FakeOidcProviders({ privateKey, jwk }, other, now);
  }

  get googleJwks(): JWTVerifyGetKey {
    return createLocalJWKSet({ keys: [this.google.jwk] });
  }

  /** OidcDeps for createApiApp (`oidc`). */
  deps(now: () => Date): Partial<OidcDeps> {
    return { fetch: (url, init) => this.fetch(url, init), googleJwks: this.googleJwks, now };
  }

  /**
   * The person signs in at the provider: returns the `code` and `state` the provider sends to the
   * redirect URI. `claims` are the ID token's person claims (`sub`, `email`, ...).
   */
  authorize(authorizationUrl: string, claims: JWTPayload): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const provider = (Object.keys(OIDC_PROVIDER_METADATA) as OidcProvider[]).find(
      (p) => OIDC_PROVIDER_METADATA[p].authorizationEndpoint === `${url.origin}${url.pathname}`,
    );
    if (provider === undefined) throw new Error('Unknown authorization endpoint');
    const q = url.searchParams;
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') {
      throw new Error('Not an authorization code request with PKCE S256');
    }
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, {
      provider,
      clientId: q.get('client_id') ?? '',
      redirectUri: q.get('redirect_uri') ?? '',
      codeChallenge: q.get('code_challenge') ?? '',
      claims: { nonce: q.get('nonce') ?? undefined, ...claims },
    });
    return { code, state: q.get('state') ?? '' };
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    this.tokenRequests.push({ url, form, signal: init.signal instanceof AbortSignal });
    const fault = this.nextFault;
    this.nextFault = null;
    if (fault?.kind === 'network') throw new TypeError('fetch failed');
    if (fault?.kind === 'status') return Response.json({ error: 'x' }, { status: fault.status });
    const provider = (Object.keys(OIDC_PROVIDER_METADATA) as OidcProvider[]).find(
      (p) => OIDC_PROVIDER_METADATA[p].tokenEndpoint === url,
    );
    const pending = this.codes.get(form.get('code') ?? '');
    const secret = provider === 'line' ? TEST_LINE_CHANNEL_SECRET : TEST_GOOGLE_CLIENT_SECRET;
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (
      init.method !== 'POST' ||
      provider === undefined ||
      pending === undefined ||
      pending.provider !== provider ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('client_id') !== pending.clientId ||
      form.get('client_secret') !== secret ||
      form.get('redirect_uri') !== pending.redirectUri ||
      challenge !== pending.codeChallenge
    ) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    this.codes.delete(form.get('code') ?? ''); // codes are single-use
    if (fault?.kind === 'no-id-token') return Response.json({ access_token: 'x' });
    const claims = { ...pending.claims, ...(fault?.kind === 'claims' ? fault.claims : {}) };
    const idToken = await this.idToken(
      provider,
      pending.clientId,
      claims,
      fault?.kind === 'wrong-key',
    );
    return Response.json({ access_token: randomUUID(), token_type: 'Bearer', id_token: idToken });
  }

  private idToken(
    provider: OidcProvider,
    clientId: string,
    claims: JWTPayload,
    wrongKey: boolean,
  ): Promise<string> {
    const now = Math.floor(this.now().getTime() / 1000);
    const { iss, aud, exp, iat, ...rest } = claims;
    const jwt = new SignJWT(rest)
      .setIssuer(
        typeof iss === 'string' ? iss : (OIDC_PROVIDER_METADATA[provider].issuers[0] ?? ''),
      )
      .setAudience(typeof aud === 'string' ? aud : clientId)
      .setIssuedAt(typeof iat === 'number' ? iat : now)
      .setExpirationTime(typeof exp === 'number' ? exp : now + 3600);
    if (provider === 'google') {
      return jwt
        .setProtectedHeader({ alg: 'RS256', kid: this.google.jwk.kid ?? '' })
        .sign(wrongKey ? this.otherGoogleKey : this.google.privateKey);
    }
    return jwt
      .setProtectedHeader({ alg: 'HS256' })
      .sign(
        new TextEncoder().encode(
          wrongKey ? 'another-channel-secret-xyz' : TEST_LINE_CHANNEL_SECRET,
        ),
      );
  }
}
