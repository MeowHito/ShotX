import {
  type AuthClientConfig,
  apiIssuesTokens,
  type Env,
  loadAppConfig,
  loadAuthClientConfig,
  loadAuthProviderConfig,
  loadAdminBffAuthConfig,
  loadAdminPasswordUiConfig,
  loadInternalApiConfig,
} from '@shotx/shared';
import type { PasswordUiConfig } from '../users/password';

/**
 * Server-side settings of the admin app, read from the environment at request time (never at
 * build time: the Docker image is built once and configured per stage).
 */
export interface AdminConfig {
  /** Origin of the admin app (ADMIN_BASE_URL): same-origin checks, redirects, cookie security. */
  adminBaseUrl: string;
  /** API origin (API_INTERNAL_URL); routes are under `/api` on it. */
  apiInternalUrl: string;
  /**
   * AUTH_ADMIN_BFF_KEY, the admin app's own BFF key (not the web app's AUTH_BFF_KEY), sent in
   * x-shotx-bff-key on every server-side API call (secret: never log it).
   */
  bffKey: string;
  /** AUTH_CLIENT_TIMEOUT_MS and AUTH_REFRESH_REUSE_GRACE_SECONDS. */
  authClient: AuthClientConfig;
  /** `Secure` and `__Host-` cookies; off only on plain-http localhost. */
  secureCookies: boolean;
  /** What the browser UI needs (no secrets). */
  ui: AdminUiConfig;
}

/** Settings the client components receive as props. */
export interface AdminUiConfig {
  /**
   * `generatedLength`: ADMIN_GENERATED_PASSWORD_LENGTH, the "generate" button's length;
   * `minLength`: ADMIN_PASSWORD_MIN_LENGTH and PHOTOGRAPHER_PASSWORD_MIN_LENGTH, read with the same
   * loaders as the API, for the form hints and the check before submitting.
   */
  passwords: PasswordUiConfig;
}

/**
 * Reads the UI settings: loadAdminPasswordUiConfig (ADMIN_GENERATED_PASSWORD_LENGTH and both
 * pools' minimum lengths, with the API's loaders). It refuses a generated length below the
 * required minimum.
 */
export function loadAdminUiConfig(env: Env): AdminUiConfig {
  return { passwords: loadAdminPasswordUiConfig(env) };
}

/**
 * Reads the admin app's configuration. Admin sign-in (password + TOTP) is issued by the API, so
 * AUTH_PROVIDER must be `shotx` or `local` (ADR 0008 section 4, ADR 0010); the admin app has no
 * Cognito flow. AUTH_ADMIN_BFF_KEY is then required (loadAdminBffAuthConfig); the admin app never
 * reads the web app's AUTH_BFF_KEY.
 */
export function loadAdminConfig(env: Env): AdminConfig {
  const app = loadAppConfig(env);
  const { provider } = loadAuthProviderConfig(env);
  if (!apiIssuesTokens(provider)) {
    throw new Error(
      'Invalid admin configuration: the admin app needs AUTH_PROVIDER=shotx or local (API-issued sign-in)',
    );
  }
  const bff = loadAdminBffAuthConfig(env);
  if (bff === null) {
    throw new Error('Invalid admin configuration: AUTH_ADMIN_BFF_KEY is required');
  }
  return {
    adminBaseUrl: app.adminBaseUrl,
    apiInternalUrl: loadInternalApiConfig(env).apiInternalUrl,
    bffKey: bff.key,
    authClient: loadAuthClientConfig(env),
    secureCookies: app.adminBaseUrl.startsWith('https://'),
    ui: loadAdminUiConfig(env),
  };
}

let cached: AdminConfig | undefined;

/** {@link loadAdminConfig} of `process.env`, cached for the process. */
export function adminConfig(): AdminConfig {
  cached ??= loadAdminConfig(process.env);
  return cached;
}
