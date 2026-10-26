import type { ShotxAuthConfig } from '@shotx/shared';
import type { ApiConfig } from '../config';
import type { Clock } from '../tokens';
import { OidcClients, type OidcDeps, remoteGoogleJwks } from './oidc';
import { ShotxTokenIssuer } from './shotx-tokens';

/** Injection token of the API's own token issuer (null with AUTH_PROVIDER=cognito). */
export const SHOTX_AUTH = Symbol('SHOTX_AUTH');

/** Everything the `/auth/*` routes need besides the database, Redis and the clock. */
export interface ShotxAuth {
  config: ShotxAuthConfig;
  issuer: ShotxTokenIssuer;
  oidc: OidcClients;
}

/**
 * The token issuer and OIDC clients of AUTH_PROVIDER=shotx or local; null with `cognito`.
 * `oidc` overrides the HTTP client and Google's JWKS (tests use local fakes, never the network).
 */
export function createShotxAuth(
  config: Pick<ApiConfig, 'app' | 'shotxAuth'>,
  clock: Clock,
  oidc: Partial<OidcDeps> = {},
): ShotxAuth | null {
  if (config.shotxAuth === null) return null;
  const timeoutMs = oidc.timeoutMs ?? config.shotxAuth.oidcHttpTimeoutMs;
  return {
    config: config.shotxAuth,
    issuer: new ShotxTokenIssuer(config.app.stage, config.shotxAuth, clock),
    oidc: new OidcClients(config.shotxAuth.oidc, {
      fetch: oidc.fetch ?? ((url, init) => fetch(url, init)),
      googleJwks: oidc.googleJwks ?? remoteGoogleJwks(timeoutMs),
      timeoutMs,
      now: oidc.now ?? (() => clock.now()),
    }),
  };
}
