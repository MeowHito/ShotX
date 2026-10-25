import { z } from 'zod';
import type { AuthPool } from '../domain';
import { type Env, parseEnv } from './env';
import { httpUrl } from './fields';

/** Environment variables of each Cognito user pool (set by infra; see ADR 0002). */
export const COGNITO_ENV = {
  users: {
    userPoolId: 'COGNITO_USER_POOL_ID',
    clientId: 'COGNITO_WEB_CLIENT_ID',
    domain: 'COGNITO_DOMAIN',
  },
  admins: {
    userPoolId: 'COGNITO_ADMIN_USER_POOL_ID',
    clientId: 'COGNITO_ADMIN_CLIENT_ID',
    domain: 'COGNITO_ADMIN_DOMAIN',
  },
} as const satisfies Record<AuthPool, { userPoolId: string; clientId: string; domain: string }>;

/** `<region>_<id>`, e.g. `ap-southeast-1_AbC123xyZ`. */
const USER_POOL_ID = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})_[0-9A-Za-z]{1,55}$/;

const userPoolId = z.string().regex(USER_POOL_ID, { error: 'must be a Cognito user pool id' });
const clientId = z.string().regex(/^[0-9a-z]{1,128}$/, { error: 'must be a Cognito client id' });

export interface CognitoPoolConfig {
  userPoolId: string;
  /** App client of the pool (web for `users`, admin for `admins`). */
  clientId: string;
  /** Hosted UI / OAuth origin, e.g. `https://<prefix>.auth.ap-southeast-1.amazoncognito.com`. */
  domain: string;
  /** Region of the pool, taken from its id. */
  region: string;
  /** Expected `iss` of the pool's tokens: `https://cognito-idp.<region>.amazonaws.com/<pool id>`. */
  issuer: string;
}

/**
 * Reads the settings of the given Cognito user pools. web asks for `users`, admin for `admins`,
 * and api for both; all variables of a requested pool are required.
 */
export function loadCognitoConfig<P extends AuthPool>(
  env: Env,
  pools: readonly P[],
): Record<P, CognitoPoolConfig> {
  const schema = z.object(
    Object.fromEntries(
      pools.flatMap((pool) => [
        [COGNITO_ENV[pool].userPoolId, userPoolId],
        [COGNITO_ENV[pool].clientId, clientId],
        [COGNITO_ENV[pool].domain, httpUrl({ httpsOnly: true })],
      ]),
    ),
  );
  const e = parseEnv(schema, env, 'Cognito') as Record<string, string>;
  return Object.fromEntries(
    pools.map((pool) => {
      const names = COGNITO_ENV[pool];
      const id = e[names.userPoolId] ?? '';
      const region = USER_POOL_ID.exec(id)?.[1] ?? '';
      const config: CognitoPoolConfig = {
        userPoolId: id,
        clientId: e[names.clientId] ?? '',
        domain: e[names.domain] ?? '',
        region,
        issuer: `https://cognito-idp.${region}.amazonaws.com/${id}`,
      };
      return [pool, config];
    }),
  ) as Record<P, CognitoPoolConfig>;
}
