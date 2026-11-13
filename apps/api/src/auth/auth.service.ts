import { Inject, Injectable } from '@nestjs/common';
import { userPasswordCredentials, users } from '@shotx/db';
import {
  adminSessionSatisfiesMfaMode,
  authProvidersOf,
  type AuthPool,
  type AuthProvidersResponse,
  type AuthTokenResponse,
  type AuthMethod,
  localDevSubject,
  OIDC_PROVIDERS,
  type OidcProvider,
  type OidcStartResponse,
  WEB_AUTH_CALLBACK_PATH,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApiConfig } from '../config';
import type { Db, Queryable } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { sha256Hex } from '../http/client';
import { validationError } from '../http/zod';
import { enforceRate } from '../public/share-page.service';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  KEY_VALUE_STORE,
  type KeyValueStore,
  RATE_LIMITER,
  type RateLimiter,
} from '../tokens';
import {
  type IssuedRefreshToken,
  newOpaqueToken,
  revokeFamily,
  revokeSessionByToken,
  rotateSession,
  type SessionUser,
  startSession,
  storeRefreshGrace,
} from './sessions';
import { SHOTX_AUTH, type ShotxAuth } from './shotx-auth';
import { amrForSubject } from './shotx-tokens';
import { assertAccountActive, provisionUser } from './users';

/** Redis key of a pending OIDC sign-in (the state is stored hashed). */
export const oidcStateKey = (state: string) => `auth:oidc:${sha256Hex(state)}`;

const pendingLoginSchema = z.object({
  provider: z.enum(OIDC_PROVIDERS),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().min(1),
});

/** JSON.parse that answers undefined for null or malformed input (values read from Redis). */
export function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The token response of a sign-in or refresh (AuthTokenResponse). `passwordChange`: a restricted
 * photographer session (PASSWORD_CHANGE_CLAIM, ADR 0010).
 */
export async function tokenResponse(
  auth: ShotxAuth,
  pool: AuthPool,
  user: SessionUser,
  session: IssuedRefreshToken,
  amr: readonly AuthMethod[],
  now: Date,
  options: { passwordChange?: boolean } = {},
): Promise<AuthTokenResponse> {
  const access = await auth.issuer.accessToken(pool, {
    subject: user.authSubject,
    sessionId: session.familyId,
    amr,
    ...(options.passwordChange === true ? { passwordChange: true } : {}),
  });
  return {
    accessToken: access.token,
    refreshToken: session.refreshToken,
    expiresIn: access.expiresIn,
    refreshExpiresIn: Math.max(1, Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000)),
    user: { email: user.email, name: user.name },
  };
}

/** `users.last_sign_in_at` = now: every successful sign-in, any pool (ADR 0010). */
export async function markSignedIn(q: Queryable, userId: string, now: Date): Promise<void> {
  await q.update(users).set({ lastSignInAt: now }).where(eq(users.id, userId));
}

/**
 * What a refresh re-reads (ADR 0010): the account's status and, for photographer password
 * accounts, whether the password is still temporary (null without password credentials).
 */
async function refreshState(
  q: Queryable,
  userId: string,
): Promise<{ status: 'active' | 'disabled'; mustChangePassword: boolean | null } | null> {
  const [row] = await q
    .select({
      status: users.status,
      mustChangePassword: userPasswordCredentials.mustChangePassword,
    })
    .from(users)
    .leftJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/** The token-response fields of a users row. */
export async function sessionUser(db: Queryable, id: string): Promise<SessionUser> {
  const [row] = await db
    .select({ id: users.id, authSubject: users.authSubject, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (row === undefined) throw new Error('Signed-in user row is missing');
  return row;
}

/**
 * The users-pool sign-ins (LINE, Google, development login), refresh and logout of
 * AUTH_PROVIDER=shotx or local (AUTH_ROUTES). With `cognito` every method is NOT_FOUND.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SHOTX_AUTH) private readonly auth: ShotxAuth | null,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The issuer, or NOT_FOUND with AUTH_PROVIDER=cognito. */
  private shotx(): ShotxAuth {
    if (this.auth === null) throw notFound('Route');
    return this.auth;
  }

  private loginRate(ipHash: string): Promise<void> {
    return enforceRate(
      this.limiter,
      `auth-login:ip:${ipHash}`,
      this.shotx().config.loginRateLimitPerIp,
    );
  }

  providers(): AuthProvidersResponse {
    // The same answer the share guard decides require_login with (authProvidersOf).
    return authProvidersOf(this.shotx().config);
  }

  /** The exact redirect URI the API accepts. */
  allowedRedirectUri(): string {
    return `${new URL(this.config.app.publicBaseUrl).origin}${WEB_AUTH_CALLBACK_PATH}`;
  }

  async oidcStart(
    provider: OidcProvider,
    redirectUri: string,
    ipHash: string,
  ): Promise<OidcStartResponse> {
    const auth = this.shotx();
    auth.oidc.client(provider); // AUTH_PROVIDER_UNAVAILABLE before anything is stored
    if (redirectUri !== this.allowedRedirectUri()) {
      throw validationError(['redirectUri'], 'must be the registered sign-in callback');
    }
    await this.loginRate(ipHash);
    const state = newOpaqueToken();
    const pending = {
      provider,
      nonce: newOpaqueToken(),
      codeVerifier: newOpaqueToken(),
      redirectUri,
    };
    await this.store.setWithTtl(
      oidcStateKey(state),
      JSON.stringify(pending),
      auth.config.loginStateTtlSeconds,
    );
    return { authorizationUrl: auth.oidc.authorizationUrl(provider, { state, ...pending }), state };
  }

  async oidcCallback(state: string, code: string, ipHash: string): Promise<AuthTokenResponse> {
    const auth = this.shotx();
    await this.loginRate(ipHash);
    // One-time: taken before the exchange, so a replayed state never reaches the provider.
    const raw = await this.store.take(oidcStateKey(state));
    const parsed = pendingLoginSchema.safeParse(parseJson(raw));
    if (!parsed.success) {
      throw new ApiError('LOGIN_STATE_INVALID', 'Sign-in expired; start again');
    }
    const pending = parsed.data;
    if (pending.redirectUri !== this.allowedRedirectUri()) {
      throw new ApiError('LOGIN_STATE_INVALID', 'Sign-in expired; start again');
    }
    const identity = await auth.oidc.exchange(pending.provider, {
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      nonce: pending.nonce,
    });
    return this.signIn(auth, identity.subject, identity.email, identity.name);
  }

  async devLogin(email: string, name: string, ipHash: string): Promise<AuthTokenResponse> {
    const auth = this.shotx();
    if (auth.config.devLogin === null) throw notFound('Route');
    await this.loginRate(ipHash);
    return this.signIn(auth, localDevSubject(email), email.trim(), name);
  }

  /**
   * Provisions the users-pool row (first sign-in only) and starts a session. A disabled account
   * (ADR 0010) gets no session: ACCOUNT_DISABLED.
   */
  private async signIn(
    auth: ShotxAuth,
    subject: string,
    email: string | null,
    name: string | null,
  ): Promise<AuthTokenResponse> {
    const now = this.clock.now();
    const user = await provisionUser(this.db, {
      pool: 'users',
      sub: subject,
      tokenUse: 'id',
      email,
      name,
      issuer: 'shotx',
    });
    assertAccountActive(user);
    await markSignedIn(this.db, user.id, now);
    const session = await startSession(this.db, {
      userId: user.id,
      pool: 'users',
      now,
      ttlSeconds: auth.config.pools.users.refreshTokenTtlSeconds,
      amr: amrForSubject(subject),
    });
    return tokenResponse(
      auth,
      'users',
      await sessionUser(this.db, user.id),
      session,
      amrForSubject(subject),
      now,
    );
  }

  async refresh(refreshToken: string, pool: AuthPool): Promise<AuthTokenResponse> {
    const auth = this.shotx();
    if (!auth.issuer.poolEnabled(pool)) {
      throw new ApiError('REFRESH_TOKEN_INVALID', 'Sign in again');
    }
    const now = this.clock.now();
    const result = await rotateSession(this.db, {
      refreshToken,
      pool,
      now,
      grace: storeRefreshGrace(this.store, auth.config.refreshReuseGraceSeconds),
    });
    if (result.kind === 'reused') {
      throw new ApiError('REFRESH_TOKEN_REUSED', 'Sign in again');
    }
    if (result.kind === 'invalid') throw new ApiError('REFRESH_TOKEN_INVALID', 'Sign in again');
    // ADR 0010: a disabled account's sessions were revoked when it was disabled; should one have
    // been rotated in the same instant, end it now. A temporary password keeps the session
    // restricted (PASSWORD_CHANGE_CLAIM) until it is changed.
    const state = await refreshState(this.db, result.user.id);
    if (state?.status !== 'active') {
      await revokeFamily(this.db, result.issued.familyId, now);
      throw new ApiError('REFRESH_TOKEN_INVALID', 'Sign in again');
    }
    // ADR 0011 decision 4: an admins-pool session keeps its sign-in's methods; one that no longer
    // satisfies ADMIN_MFA_MODE (a password-only sign-in after a switch to `totp`) ends here.
    if (
      pool === 'admins' &&
      !adminSessionSatisfiesMfaMode(result.issued.amr, auth.config.admin?.mfaMode ?? 'totp')
    ) {
      await revokeFamily(this.db, result.issued.familyId, now);
      throw new ApiError('REFRESH_TOKEN_INVALID', 'Sign in again');
    }
    let amr: AuthMethod[];
    try {
      // The family's stored methods, never more; families from before migration 0012 derive
      // them from the subject as before.
      amr = result.issued.amr ?? amrForSubject(result.user.authSubject);
      return await tokenResponse(auth, pool, result.user, result.issued, amr, now, {
        // ADR 0018: an admin acting in the account isn't held to its temporary password.
        passwordChange:
          pool === 'users' &&
          state.mustChangePassword === true &&
          (result.issued.actingAdminId ?? null) === null,
      });
    } catch (error) {
      // A session the issuer may no longer serve (e.g. a dev-login session after leaving
      // AUTH_PROVIDER=local): the rotation stands, the caller signs in again.
      if (error instanceof ApiError) throw error;
      throw new ApiError('REFRESH_TOKEN_INVALID', 'Sign in again');
    }
  }

  /** Revokes the token's family if it belongs to `pool` (the caller's BFF key); else a no-op. */
  async logout(refreshToken: string, pool: AuthPool): Promise<void> {
    this.shotx();
    await revokeSessionByToken(this.db, refreshToken, this.clock.now(), pool);
  }
}
