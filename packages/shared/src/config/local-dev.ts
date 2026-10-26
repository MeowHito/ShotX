import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { assertLocalStage } from './stage-gate';

// Development-only replacements for the managed services a laptop doesn't have (Cognito,
// CloudFront). Each is refused anywhere but APP_STAGE=local with a non-production NODE_ENV: an
// allowlist, so a mistyped stage name can never enable them.

export { LOCAL_DEV_APP_STAGE } from './stage-gate';

// The auth stand-in (AUTH_PROVIDER=local) lives in auth.ts.

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
