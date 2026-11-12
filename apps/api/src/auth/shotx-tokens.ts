import { createPrivateKey, createPublicKey, type KeyObject, randomUUID } from 'node:crypto';
import {
  ACCESS_TOKEN_USE,
  AUTH_TOKEN_ALGORITHM,
  accessTokenClaimsSchema,
  accessTokenClaimsSchemaFor,
  type AuthMethod,
  type AdminMfaMode,
  type AuthPool,
  hasRequiredAmr,
  PASSWORD_CHANGE_CLAIM,
  isAuthSubjectInPool,
  parseAuthSubject,
  type PoolTokenConfig,
  type ShotxAuthConfig,
} from '@shotx/shared';
import { decodeProtectedHeader, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { ApiError } from '../http/api-error';
import { type Clock, systemClock, type TokenVerifier, type VerifiedIdentity } from '../tokens';

// Access tokens the API issues itself (AUTH_PROVIDER=shotx or local; ADR 0008 section 4): EdDSA
// with one Ed25519 key per pool, `kid` per key, `iss` per pool and stage, `aud` per app.

/** JWS `typ` of access tokens (RFC 9068), so no other JWT can pass as one. */
export const ACCESS_TOKEN_TYPE = 'at+jwt';

const unauthenticated = () => new ApiError('UNAUTHENTICATED', 'Invalid or expired token');

/**
 * ADMIN_MFA_MODE of the config (ADR 0011 decision 4); `totp`, the stricter rule, when admin
 * sign-in is off (no admins-pool token is issued or accepted then anyway).
 */
function mfaModeOf(config: ShotxAuthConfig): AdminMfaMode {
  return config.admin?.mfaMode ?? 'totp';
}

/** The pools a config issues tokens for (admins only when the admins pool is on). */
function poolEntries(config: ShotxAuthConfig): [AuthPool, PoolTokenConfig][] {
  const entries: [AuthPool, PoolTokenConfig][] = [['users', config.pools.users]];
  if (config.pools.admins !== null) entries.push(['admins', config.pools.admins]);
  return entries;
}

/**
 * The `amr` of tokens for a subject: `fed` for LINE and Google, `dev` for the development login,
 * `pwd` for photographer email + password accounts (ADR 0010), `pwd` + `otp` + `mfa` for ShotX
 * admins (whose sessions start only after TOTP). Refreshes re-issue the same methods: a session's
 * way of signing in never changes.
 */
export function amrForSubject(subject: string): AuthMethod[] {
  const parsed = parseAuthSubject(subject);
  switch (parsed?.provider) {
    case 'line':
    case 'google':
      return ['fed'];
    case 'local':
      return ['dev'];
    case 'password':
      return ['pwd'];
    case 'admin':
      return ['pwd', 'otp', 'mfa'];
    default:
      throw new RangeError('Not a ShotX-issued subject');
  }
}

/**
 * Verifies ShotX access tokens of both pools. The pool is chosen by the `kid` (every key id is
 * unique across pools, loadShotxAuthConfig), then the signature is checked with that pool's key
 * only (current or previous), with the pool's `iss` and `aud`, and the claims are parsed with
 * accessTokenClaimsSchemaFor. An admins-pool token whose only fault is a missing `otp`/`pwd` in
 * `amr` is returned (with its `amr`) so the admin guard can answer MFA_REQUIRED; anything else
 * invalid is UNAUTHENTICATED. Development-login subjects (`local:`) verify only while the
 * development login is on.
 *
 * Verification is stateless: an access token stays valid until it expires, at most
 * AUTH_ACCESS_TOKEN_TTL_SECONDS after logout, a reuse revocation or an operator reset (ADR 0008
 * section 4). Users-pool routes accept that window; AdminGuard additionally checks the token's
 * `sid` against auth_sessions and the account's lockout, so for admins a reset, revocation or
 * lockout takes effect immediately.
 */
export class ShotxTokenVerifier implements TokenVerifier {
  private readonly keys = new Map<string, { pool: AuthPool; key: KeyObject }>();

  constructor(
    private readonly stage: string,
    private readonly config: ShotxAuthConfig,
    private readonly clock: Clock = systemClock,
  ) {
    for (const [pool, poolConfig] of poolEntries(config)) {
      const { current, previous } = poolConfig.signing;
      this.keys.set(current.kid, { pool, key: createPublicKey(current.privateKeyPem) });
      if (previous !== null) {
        this.keys.set(previous.kid, { pool, key: createPublicKey(previous.publicKeyPem) });
      }
    }
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let kid: unknown;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== AUTH_TOKEN_ALGORITHM || header.typ !== ACCESS_TOKEN_TYPE) {
        throw unauthenticated();
      }
      kid = header.kid;
    } catch {
      throw unauthenticated();
    }
    const entry = typeof kid === 'string' ? this.keys.get(kid) : undefined;
    if (entry === undefined) throw unauthenticated();
    const { pool, key } = entry;
    const poolConfig = pool === 'users' ? this.config.pools.users : this.config.pools.admins;
    if (poolConfig === null) throw unauthenticated();

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: [AUTH_TOKEN_ALGORITHM],
        typ: ACCESS_TOKEN_TYPE,
        issuer: poolConfig.issuer,
        audience: poolConfig.audience,
        currentDate: this.clock.now(),
        requiredClaims: ['sub', 'exp', 'iat', 'sid', 'idp', 'amr', 'token_use'],
      }));
    } catch {
      throw unauthenticated();
    }

    const strict = accessTokenClaimsSchemaFor(this.stage, pool, {
      adminMfaMode: mfaModeOf(this.config),
    }).safeParse(payload);
    let claims;
    if (strict.success) {
      claims = strict.data;
    } else {
      // Only an `amr` short of the pool's requirement is passed on (MFA_REQUIRED at the guard).
      const onlyAmr = strict.error.issues.every((issue) => issue.path[0] === 'amr');
      const loose = accessTokenClaimsSchema.safeParse(payload);
      if (!onlyAmr || !loose.success || pool !== 'admins') throw unauthenticated();
      claims = loose.data;
    }
    if (claims.idp === 'local' && this.config.devLogin === null) throw unauthenticated();
    return {
      pool,
      sub: claims.sub,
      tokenUse: 'access',
      email: null,
      name: null,
      issuer: 'shotx',
      amr: claims.amr,
      sessionId: claims.sid,
      ...(claims[PASSWORD_CHANGE_CLAIM] === true ? { passwordChange: true } : {}),
    };
  }
}

export interface IssuedAccessToken {
  token: string;
  /** Seconds the token lives. */
  expiresIn: number;
}

/**
 * Signs access tokens with the pool's current key. Refuses (throws, a server bug) to sign an
 * admins-pool token without ADMIN_REQUIRED_AMR, a subject outside its pool, or a pool that is
 * off: the only code path that passes admin methods is the TOTP step (AdminSignIn.verifyMfa).
 */
export class ShotxTokenIssuer {
  private readonly signingKeys = new Map<AuthPool, { kid: string; key: KeyObject }>();

  constructor(
    private readonly stage: string,
    private readonly config: ShotxAuthConfig,
    private readonly clock: Clock = systemClock,
  ) {
    for (const [pool, poolConfig] of poolEntries(config)) {
      const { kid, privateKeyPem } = poolConfig.signing.current;
      this.signingKeys.set(pool, { kid, key: createPrivateKey(privateKeyPem) });
    }
  }

  /** True when the pool issues tokens here (admins: AUTH_ADMINS_SIGNING_KEY and the TOTP key). */
  poolEnabled(pool: AuthPool): boolean {
    if (pool === 'admins') return this.signingKeys.has('admins') && this.config.admin !== null;
    return this.signingKeys.has(pool);
  }

  /**
   * `passwordChange`: add PASSWORD_CHANGE_CLAIM (a restricted session of a photographer whose
   * password is temporary; users pool, `password:` subjects only, else a thrown bug).
   */
  async accessToken(
    pool: AuthPool,
    input: {
      subject: string;
      sessionId: string;
      amr: readonly AuthMethod[];
      passwordChange?: boolean;
    },
  ): Promise<IssuedAccessToken> {
    const signing = this.signingKeys.get(pool);
    const poolConfig = pool === 'users' ? this.config.pools.users : this.config.pools.admins;
    if (signing === undefined || poolConfig === null || !this.poolEnabled(pool)) {
      throw new Error(`The ${pool} pool does not issue tokens here`);
    }
    if (!hasRequiredAmr(pool, input.amr, mfaModeOf(this.config))) {
      throw new Error(`Refusing to issue a ${pool} token without the required amr`);
    }
    if (!isAuthSubjectInPool(input.subject, pool)) {
      throw new Error(`Refusing to issue a ${pool} token for a subject of another pool`);
    }
    const parsed = parseAuthSubject(input.subject);
    if (parsed === null || parsed.provider === 'cognito') {
      throw new Error('Refusing to issue a token for a Cognito subject');
    }
    if (parsed.provider === 'local' && this.config.devLogin === null) {
      throw new Error('Refusing to issue a development-login token');
    }
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const ttl = this.config.accessTokenTtlSeconds;
    if (input.passwordChange === true && (pool !== 'users' || parsed.provider !== 'password')) {
      throw new Error('Only photographer password sessions can require a password change');
    }
    const claims = {
      sid: input.sessionId,
      idp: parsed.provider,
      amr: [...input.amr],
      token_use: ACCESS_TOKEN_USE,
      ...(input.passwordChange === true ? { [PASSWORD_CHANGE_CLAIM]: true as const } : {}),
    };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: AUTH_TOKEN_ALGORITHM, kid: signing.kid, typ: ACCESS_TOKEN_TYPE })
      .setIssuer(poolConfig.issuer)
      .setAudience(poolConfig.audience)
      .setSubject(input.subject)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .setJti(randomUUID())
      .sign(signing.key);
    // The issuer checks its own output against the contract the verifier applies.
    accessTokenClaimsSchemaFor(this.stage, pool, { adminMfaMode: mfaModeOf(this.config) }).parse({
      ...claims,
      iss: poolConfig.issuer,
      aud: poolConfig.audience,
      sub: input.subject,
      iat: now,
      exp: now + ttl,
    });
    return { token, expiresIn: ttl };
  }
}
