import { z } from 'zod';
import { AUTH_PROVIDER_NAMES, apiIssuesTokens } from './auth';
import { DEFAULT_AWS_REGION } from './aws';
import { type Env, parseEnv } from './env';
import { awsRegion, httpUrl } from './fields';
import { EMAIL_PROVIDERS } from './billing';
import { LOCAL_DEV_APP_STAGE } from './stage-gate';

// Explicit settings for the AWS clients that stay on AWS after ADR 0008: Rekognition (face) and
// SES (email). ADR 0008 section 1: endpoints and credentials are explicit per client, because AWS
// SDK v3 applies the AWS_ENDPOINT_URL environment variable to every client (it would send
// Rekognition to R2 or LocalStack) and the default credential chain would pick up whatever
// AWS_ACCESS_KEY_ID happens to be set. Shared stays SDK-free: awsClientOptions() returns plain
// options that packages/face, api and worker spread into the SDK client.

/** Static access keys of one AWS IAM user. Secret: never log it. */
export interface AwsStaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Region, endpoint and credentials of one AWS service client. */
export interface AwsClientConfig {
  /** `<SERVICE>_REGION`, else AWS_REGION, else ap-southeast-1. */
  region: string;
  /**
   * `<SERVICE>_ENDPOINT_URL`: an override for tests and LocalStack only (outside APP_STAGE=local
   * only an https AWS endpoint is accepted). Null: the SDK's regional endpoint, unless the
   * AWS_ENDPOINT_URL environment variable is set, which the SDK itself applies to clients without
   * an explicit endpoint; so off AWS AWS_ENDPOINT_URL must stay unset.
   */
  endpointUrl: string | null;
  /**
   * `<SERVICE>_ACCESS_KEY_ID` / `<SERVICE>_SECRET_ACCESS_KEY`. Required off AWS
   * (runsOffAws); optional on the AWS stacks, where null means the ECS task role. Secret.
   */
  credentials: AwsStaticCredentials | null;
}

/** Plain options shaped like an AWS SDK v3 client config (spread them into the client). */
export interface AwsClientOptions {
  region: string;
  endpoint?: string;
  credentials?: AwsStaticCredentials;
}

/**
 * SDK client options from an AwsClientConfig: `region` always, `endpoint` and `credentials` when
 * configured. Contains the secret key: never log the result.
 */
export function awsClientOptions(config: AwsClientConfig): AwsClientOptions {
  return {
    region: config.region,
    ...(config.endpointUrl === null ? {} : { endpoint: config.endpointUrl }),
    ...(config.credentials === null ? {} : { credentials: { ...config.credentials } }),
  };
}

const offAwsEnvSchema = z.object({
  AUTH_PROVIDER: z.enum(AUTH_PROVIDER_NAMES).default('cognito'),
  STORAGE_ENDPOINT_URL: z.string().optional(),
});

/**
 * True when the services run off AWS (the VPS of ADR 0008, and local development like it): the
 * API issues its own tokens (AUTH_PROVIDER=shotx or local) or storage is not AWS S3
 * (STORAGE_ENDPOINT_URL set). There is no task role then, so every AWS client needs explicit
 * keys. The AWS stacks (cognito, no STORAGE_ENDPOINT_URL) return false.
 */
export function runsOffAws(env: Env): boolean {
  const e = parseEnv(offAwsEnvSchema, env, 'deployment');
  return apiIssuesTokens(e.AUTH_PROVIDER) || e.STORAGE_ENDPOINT_URL !== undefined;
}

/** True for an AWS service endpoint host (`*.amazonaws.com`, `*.amazonaws.com.cn`, `*.api.aws`). */
export function isAwsEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return ['.amazonaws.com', '.amazonaws.com.cn', '.api.aws'].some((suffix) =>
    host.endsWith(suffix),
  );
}

/** Environment variable names of one service's client settings. */
export interface AwsClientEnvNames {
  region: string;
  endpointUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The client settings' environment variables of Rekognition and SES. */
export const AWS_CLIENT_ENV = {
  rekognition: {
    region: 'REKOGNITION_REGION',
    endpointUrl: 'REKOGNITION_ENDPOINT_URL',
    accessKeyId: 'REKOGNITION_ACCESS_KEY_ID',
    secretAccessKey: 'REKOGNITION_SECRET_ACCESS_KEY',
  },
  ses: {
    region: 'SES_REGION',
    endpointUrl: 'SES_ENDPOINT_URL',
    accessKeyId: 'SES_ACCESS_KEY_ID',
    secretAccessKey: 'SES_SECRET_ACCESS_KEY',
  },
} as const satisfies Record<string, AwsClientEnvNames>;

/**
 * The environment variables through which AWS SDK v3 configures endpoints without code:
 * `AWS_ENDPOINT_URL` (every client) and `AWS_ENDPOINT_URL_<SERVICE_ID>` (one service, e.g.
 * `AWS_ENDPOINT_URL_REKOGNITION`, `AWS_ENDPOINT_URL_SES`, `AWS_ENDPOINT_URL_SESV2`,
 * `AWS_ENDPOINT_URL_S3`).
 */
export const AWS_SDK_ENDPOINT_ENV = /^AWS_ENDPOINT_URL(_[A-Z0-9_]+)?$/;

/** Names (never values) of the AWS_ENDPOINT_URL / AWS_ENDPOINT_URL_* variables that are set. */
export function configuredEndpointVariables(env: Env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => AWS_SDK_ENDPOINT_ENV.test(key) && value !== undefined && value !== '')
    .map(([key]) => key)
    .sort();
}

/**
 * AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: when true the SDK ignores every endpoint from the
 * environment (AWS_ENDPOINT_URL*) and from AWS config files (`endpoint_url`); an explicit
 * client `endpoint` (REKOGNITION_ENDPOINT_URL, SES_ENDPOINT_URL, STORAGE_ENDPOINT_URL) still
 * applies. The production compose (ADR 0008 step 4) sets it to true on api and worker, and
 * loadRekognitionClientConfig / loadSesClientConfig require it off AWS outside APP_STAGE=local.
 * Never set it locally: LocalStack SQS is reached through AWS_ENDPOINT_URL.
 */
const ignoreEndpointsEnvSchema = z.object({
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: z.stringbool().optional(),
});

const accessKeyId = () =>
  z.string().regex(/^[A-Z0-9]{16,128}$/, { error: 'must be an AWS access key id (A-Z, 0-9)' });
const secretAccessKey = () =>
  z
    .string()
    .min(1)
    .max(256)
    .refine((v) => !/\s/.test(v), { error: 'must not contain whitespace' });

/**
 * Reads one service's client settings (loadRekognitionClientConfig, loadSesClientConfig; and,
 * format only with `required: false`, loadFaceConfig and loadEmailConfig):
 * `<SERVICE>_REGION` (else AWS_REGION, else ap-southeast-1), `<SERVICE>_ENDPOINT_URL` (optional;
 * outside APP_STAGE=local https on an AWS host only) and both keys (both or neither; required when
 * runsOffAws). Off AWS outside APP_STAGE=local, every AWS_ENDPOINT_URL / AWS_ENDPOINT_URL_*
 * variable is refused and AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true is required. `required: false`
 * (the client won't be built, e.g. EMAIL_PROVIDER=fake) skips these requirements.
 */
export function loadAwsClientConfig(
  env: Env,
  names: AwsClientEnvNames,
  name: string,
  options: { required?: boolean } = {},
): AwsClientConfig {
  const schema = z.object({
    APP_STAGE: z.string().optional(),
    AWS_REGION: awsRegion().optional(),
    [names.region]: awsRegion().optional(),
    [names.endpointUrl]: httpUrl().optional(),
    [names.accessKeyId]: accessKeyId().optional(),
    [names.secretAccessKey]: secretAccessKey().optional(),
  });
  // A LocalStack key such as `test` is not AWS-shaped; allow any key on APP_STAGE=local.
  const local = env.APP_STAGE === LOCAL_DEV_APP_STAGE;
  const relaxed = local
    ? schema.extend({
        [names.accessKeyId]: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,128}$/, { error: 'must be an access key id' })
          .optional(),
      })
    : schema;
  const e = parseEnv(relaxed, env, name) as Record<string, string | undefined>;
  const region = e[names.region] ?? e.AWS_REGION ?? DEFAULT_AWS_REGION;
  const endpointUrl = e[names.endpointUrl] ?? null;
  if (endpointUrl !== null && !local) {
    const url = new URL(endpointUrl);
    if (url.protocol !== 'https:' || !isAwsEndpointHost(url.hostname)) {
      throw new Error(
        `Invalid ${name} configuration: ${names.endpointUrl} must be an https AWS endpoint outside APP_STAGE=${LOCAL_DEV_APP_STAGE} (it is for tests and LocalStack)`,
      );
    }
  }
  const required = options.required !== false;
  const { AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: ignoreConfigured } = parseEnv(
    ignoreEndpointsEnvSchema,
    env,
    name,
  );
  if (required && !local && runsOffAws(env)) {
    const configured = configuredEndpointVariables(env);
    if (configured.length > 0) {
      throw new Error(
        `Invalid ${name} configuration: ${configured.join(', ')} must be unset off AWS outside APP_STAGE=${LOCAL_DEV_APP_STAGE}: AWS SDK v3 applies AWS_ENDPOINT_URL to every client and AWS_ENDPOINT_URL_<SERVICE> to that service (use ${names.endpointUrl} for an override)`,
      );
    }
  }
  const id = e[names.accessKeyId];
  const secret = e[names.secretAccessKey];
  if ((id === undefined) !== (secret === undefined)) {
    throw new Error(
      `Invalid ${name} configuration: set both ${names.accessKeyId} and ${names.secretAccessKey}, or neither`,
    );
  }
  if (id === undefined && required && runsOffAws(env)) {
    throw new Error(
      `Invalid ${name} configuration: ${names.accessKeyId} and ${names.secretAccessKey} are required off AWS (AUTH_PROVIDER=shotx/local or STORAGE_ENDPOINT_URL set): there is no task role and no client may use the default credential chain`,
    );
  }
  // After the key checks, so a missing key is reported first.
  if (required && !local && runsOffAws(env) && ignoreConfigured !== true) {
    throw new Error(
      `Invalid ${name} configuration: AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true is required off AWS outside APP_STAGE=${LOCAL_DEV_APP_STAGE}, so no endpoint from the environment or an AWS config file reaches the clients`,
    );
  }
  return {
    region,
    endpointUrl,
    credentials:
      id === undefined || secret === undefined
        ? null
        : { accessKeyId: id, secretAccessKey: secret },
  };
}

/**
 * The Rekognition client (api: face search and deletion; worker: indexing, purges,
 * reconciliation; ADR 0008 sections 1 and 5): REKOGNITION_REGION (else AWS_REGION, else
 * ap-southeast-1), REKOGNITION_ENDPOINT_URL (tests and LocalStack only), and
 * REKOGNITION_ACCESS_KEY_ID / REKOGNITION_SECRET_ACCESS_KEY, required off AWS (runsOffAws) and
 * optional on the AWS stacks (null: the task role). Off AWS outside APP_STAGE=local, no
 * AWS_ENDPOINT_URL / AWS_ENDPOINT_URL_* may be set and AWS_IGNORE_CONFIGURED_ENDPOINT_URLS must be
 * true. packages/face builds its client from
 * `awsClientOptions(config)`. Secret: never log it.
 */
export function loadRekognitionClientConfig(env: Env): AwsClientConfig {
  return loadAwsClientConfig(env, AWS_CLIENT_ENV.rekognition, 'Rekognition client');
}

/**
 * The SES client (api and worker) with EMAIL_PROVIDER=ses, like loadRekognitionClientConfig but
 * from SES_REGION, SES_ENDPOINT_URL, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY. Null with
 * EMAIL_PROVIDER=fake (the SES_* values are still validated). Secret: never log it.
 */
export function loadSesClientConfig(env: Env): AwsClientConfig | null {
  // Built here, not at module level: billing.ts imports this module too.
  const schema = z.object({ EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('fake') });
  const { EMAIL_PROVIDER } = parseEnv(schema, env, 'SES client');
  const config = loadAwsClientConfig(env, AWS_CLIENT_ENV.ses, 'SES client', {
    required: EMAIL_PROVIDER === 'ses',
  });
  return EMAIL_PROVIDER === 'ses' ? config : null;
}
