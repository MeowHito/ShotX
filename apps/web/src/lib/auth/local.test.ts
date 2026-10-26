// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createLocalAuthProvider, handleLocalAuthorize, issueLocalCode, localSub } from './local';
import { createPkcePair } from './pkce';
import { jwtClaims } from './session';

const SECRET = 'local-test-secret-0123456789abcdef';
const BASE = 'http://localhost:3010';
const identity = { email: 'a@shotx.test', name: 'ช่างภาพ' };

describe('local auth provider', () => {
  const provider = createLocalAuthProvider({ secret: SECRET, publicBaseUrl: BASE });

  it('sends the browser to the local page with the state and challenge', () => {
    const url = new URL(
      provider.authorizationUrl({
        state: 's'.repeat(16),
        codeChallenge: 'c'.repeat(43),
        redirectUri: `${BASE}/auth/callback`,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/auth/local`);
    expect(url.searchParams.get('code_challenge')).toBe('c'.repeat(43));
  });

  it('exchanges a code bound to the PKCE challenge for tokens with the identity', async () => {
    const pkce = await createPkcePair();
    const code = issueLocalCode(SECRET, identity, pkce.challenge);
    const tokens = await provider.exchangeCode({
      code,
      codeVerifier: pkce.verifier,
      redirectUri: '',
    });
    expect(jwtClaims(tokens.accessToken)).toMatchObject({
      sub: localSub(identity.email),
      email: identity.email,
      name: identity.name,
      token_use: 'access',
    });
    const refreshed = await provider.refresh(tokens.refreshToken ?? '');
    expect(jwtClaims(refreshed.idToken)).toMatchObject({ token_use: 'id', email: identity.email });
  });

  it('rejects a wrong verifier, a forged code, an expired code and a forged refresh token', async () => {
    const pkce = await createPkcePair();
    const other = await createPkcePair();
    const code = issueLocalCode(SECRET, identity, pkce.challenge);
    await expect(
      provider.exchangeCode({ code, codeVerifier: other.verifier, redirectUri: '' }),
    ).rejects.toThrow(/PKCE/);
    const forged = issueLocalCode('another-secret-0123456789abcdefgh', identity, pkce.challenge);
    await expect(
      provider.exchangeCode({ code: forged, codeVerifier: pkce.verifier, redirectUri: '' }),
    ).rejects.toThrow(/Invalid code/);
    const expired = issueLocalCode(SECRET, identity, pkce.challenge, Date.now() - 10 * 60_000);
    await expect(
      provider.exchangeCode({ code: expired, codeVerifier: pkce.verifier, redirectUri: '' }),
    ).rejects.toThrow(/Invalid code/);
    await expect(provider.refresh(`${code}x`)).rejects.toThrow(/Invalid refresh token/);
    await expect(provider.refresh(code)).rejects.toThrow(/Invalid refresh token/);
  });

  it('gives one stable sub per email, case-insensitively', () => {
    expect(localSub('A@shotx.test')).toBe(localSub('a@shotx.test'));
    expect(localSub('a@shotx.test')).not.toBe(localSub('b@shotx.test'));
    expect(localSub('a@shotx.test')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('POST /auth/local/authorize', () => {
  const config = { secret: SECRET, publicBaseUrl: BASE };
  const valid = {
    state: 's'.repeat(16),
    code_challenge: 'c'.repeat(43),
    redirect_uri: `${BASE}/auth/callback`,
    email: identity.email,
    name: identity.name,
  };
  const post = (fields: Record<string, string>, cfg: typeof config | null = config) =>
    handleLocalAuthorize(
      new Request(`${BASE}/auth/local/authorize`, {
        method: 'POST',
        body: new URLSearchParams(fields),
      }),
      cfg,
    );

  it('returns to the callback with a code and the state', async () => {
    const response = await post(valid);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${BASE}/auth/callback`);
    expect(location.searchParams.get('state')).toBe(valid.state);
    expect(location.searchParams.get('code')).toBeTruthy();
  });

  it('refuses another redirect_uri, an empty state and a short challenge', async () => {
    for (const bad of [
      { redirect_uri: 'https://evil.example/auth/callback' },
      { redirect_uri: `${BASE}/auth/callback/../x` },
      { state: '' },
      { code_challenge: 'c'.repeat(42) },
    ]) {
      expect((await post({ ...valid, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('answers invalid_request for a bad identity', async () => {
    const response = await post({ ...valid, email: 'not-an-email' });
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.has('code')).toBe(false);
  });

  it('is 404 without AUTH_PROVIDER=local', async () => {
    expect((await post(valid, null)).status).toBe(404);
  });
});
