import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { NODE_ENVS } from './runtime';

// Development-only replacements for the managed services a laptop doesn't have (Cognito,
// CloudFront). Each is refused anywhere but APP_STAGE=local with a non-production NODE_ENV: an
// allowlist, so a mistyped stage name can never enable them.

/** The only APP_STAGE that may use the local replacements below. */
export const LOCAL_DEV_APP_STAGE = 'local';

const localGateSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  APP_STAGE: z.string().optional(),
});

function assertLocalStage(env: Env, what: string, name: string): void {
  const e = parseEnv(localGateSchema, env, name);
  if (e.APP_STAGE !== LOCAL_DEV_APP_STAGE || e.NODE_ENV === 'production') {
    throw new Error(
      `Invalid ${name} configuration: ${what} needs APP_STAGE=${LOCAL_DEV_APP_STAGE} and a non-production NODE_ENV`,
    );
  }
}

// --- Auth (web and api) -------------------------------------------------------------------------

/**
 * `cognito`: the Cognito user pools (every deployed stage). `local`: a sign-in that needs no
 * identity provider: web mints HS256 tokens with LOCAL_AUTH_SECRET and the API verifies them with
 * the same secret.
 */
export const AUTH_PROVIDER_NAMES = ['cognito', 'local'] as const;
export type AuthProviderName = (typeof AUTH_PROVIDER_NAMES)[number];

/** `iss` and `aud` of locally minted tokens; the API rejects anything else. */
export const LOCAL_AUTH_ISSUER = 'shotx-local-auth';
export const LOCAL_AUTH_AUDIENCE = 'shotx-local';

const authProviderEnvSchema = z.object({
  AUTH_PROVIDER: z.enum(AUTH_PROVIDER_NAMES).default('cognito'),
  /** HMAC key shared by web and api for local tokens, at least 32 characters. */
  LOCAL_AUTH_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }).optional(),
});

export type AuthProviderConfig =
  | { provider: 'cognito' }
  /** `secret` is secret: never log it. */
  | { provider: 'local'; secret: string };

/**
 * Reads AUTH_PROVIDER (default `cognito`) and, for `local`, LOCAL_AUTH_SECRET (required). `local`
 * is refused outside APP_STAGE=local.
 */
export function loadAuthProviderConfig(env: Env): AuthProviderConfig {
  const e = parseEnv(authProviderEnvSchema, env, 'auth provider');
  if (e.AUTH_PROVIDER === 'cognito') return { provider: 'cognito' };
  assertLocalStage(env, 'AUTH_PROVIDER=local', 'auth provider');
  if (e.LOCAL_AUTH_SECRET === undefined) {
    throw new Error('Invalid auth provider configuration: LOCAL_AUTH_SECRET is required');
  }
  return { provider: 'local', secret: e.LOCAL_AUTH_SECRET };
}

// --- Media URLs (api) ---------------------------------------------------------------------------

/**
 * `cloudfront`: CloudFront signed URLs (every deployed stage; never S3 URLs). `s3-presign`: S3
 * presigned GET URLs on AWS_ENDPOINT_URL (LocalStack), because there is no CloudFront locally.
 */
export const MEDIA_URL_SIGNER_NAMES = ['cloudfront', 's3-presign'] as const;
export type MediaUrlSignerName = (typeof MEDIA_URL_SIGNER_NAMES)[number];

const mediaUrlSignerEnvSchema = z.object({
  MEDIA_URL_SIGNER: z.enum(MEDIA_URL_SIGNER_NAMES).default('cloudfront'),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

export type MediaUrlSignerConfig =
  | { signer: 'cloudfront' }
  /** LocalStack credentials; `secretAccessKey` is secret: never log it. */
  | { signer: 's3-presign'; accessKeyId: string; secretAccessKey: string };

/**
 * Reads MEDIA_URL_SIGNER (default `cloudfront`) and, for `s3-presign`, AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY (required). `s3-presign` is refused outside APP_STAGE=local.
 */
export function loadMediaUrlSignerConfig(env: Env): MediaUrlSignerConfig {
  const e = parseEnv(mediaUrlSignerEnvSchema, env, 'media URL signer');
  if (e.MEDIA_URL_SIGNER === 'cloudfront') return { signer: 'cloudfront' };
  assertLocalStage(env, 'MEDIA_URL_SIGNER=s3-presign', 'media URL signer');
  if (e.AWS_ACCESS_KEY_ID === undefined || e.AWS_SECRET_ACCESS_KEY === undefined) {
    throw new Error(
      'Invalid media URL signer configuration: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required',
    );
  }
  return {
    signer: 's3-presign',
    accessKeyId: e.AWS_ACCESS_KEY_ID,
    secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
  };
}
