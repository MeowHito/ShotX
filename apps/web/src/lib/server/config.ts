import {
  type CognitoPoolConfig,
  type Env,
  loadAppConfig,
  loadAwsConfig,
  loadCognitoConfig,
  loadInternalApiConfig,
  loadUploadConfig,
} from '@shotx/shared';

/**
 * Server-side settings of the web app, read from the environment at request time (never at
 * build time: the Docker image is built once and configured per stage).
 */
export interface WebConfig {
  publicBaseUrl: string;
  apiInternalUrl: string;
  cognito: CognitoPoolConfig;
  /** `Secure` and `__Host-` cookies; off only on plain-http localhost. */
  secureCookies: boolean;
}

export function loadWebConfig(env: Env): WebConfig {
  const app = loadAppConfig(env);
  return {
    publicBaseUrl: app.publicBaseUrl,
    apiInternalUrl: loadInternalApiConfig(env).apiInternalUrl,
    cognito: loadCognitoConfig(env, ['users']).users,
    secureCookies: app.publicBaseUrl.startsWith('https://'),
  };
}

let cached: WebConfig | undefined;

/** {@link loadWebConfig} of `process.env`, cached for the process. */
export function webConfig(): WebConfig {
  cached ??= loadWebConfig(process.env);
  return cached;
}

/** What the upload UI needs from the upload config (same env and defaults as the API). */
export interface ClientUploadConfig {
  maxBytes: { image: number; video: number };
  partBytes: number;
  partConcurrency: number;
}

export function clientUploadConfig(env: Env = process.env): ClientUploadConfig {
  const upload = loadUploadConfig(env);
  return {
    maxBytes: upload.maxBytes,
    partBytes: upload.partBytes,
    partConcurrency: upload.partConcurrency,
  };
}

/**
 * Origins the browser PUTs upload parts to (CSP `connect-src`). The API presigns virtual-hosted
 * URLs on the regional endpoint. With MEDIA_BUCKET set that is exactly one origin; without it
 * (infra doesn't pass MEDIA_BUCKET to web yet) any bucket on the regional endpoint. LocalStack's
 * AWS_ENDPOINT_URL is added for local development.
 */
export function uploadOrigins(env: Env = process.env): string[] {
  const aws = loadAwsConfig(env);
  const origins: string[] = [];
  const bucket = env.MEDIA_BUCKET;
  if (bucket !== undefined && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    origins.push(`https://${bucket}.s3.${aws.region}.amazonaws.com`);
  } else {
    origins.push(`https://*.s3.${aws.region}.amazonaws.com`);
  }
  if (aws.endpointUrl !== null) origins.push(new URL(aws.endpointUrl).origin);
  return origins;
}
