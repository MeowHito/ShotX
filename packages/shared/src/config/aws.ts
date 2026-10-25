import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { awsRegion, httpUrl } from './fields';

/** The platform's region: Rekognition runs there and only reads S3 objects in its own region. */
export const DEFAULT_AWS_REGION = 'ap-southeast-1';

const awsEnvSchema = z.object({
  AWS_REGION: awsRegion().default(DEFAULT_AWS_REGION),
  /** LocalStack only, e.g. `http://localhost:4566`. Unset on AWS. */
  AWS_ENDPOINT_URL: httpUrl().optional(),
});

/**
 * AWS SDK client settings shared by every client (S3, SQS, Rekognition). Credentials are not part
 * of it: the SDK's default chain reads them (the task role on ECS, AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY for LocalStack).
 */
export interface AwsConfig {
  region: string;
  /** Endpoint override for LocalStack, or null to use the real AWS endpoints. */
  endpointUrl: string | null;
}

/** Reads AWS_REGION (default ap-southeast-1) and AWS_ENDPOINT_URL (optional). */
export function loadAwsConfig(env: Env): AwsConfig {
  const e = parseEnv(awsEnvSchema, env, 'AWS');
  return { region: e.AWS_REGION, endpointUrl: e.AWS_ENDPOINT_URL ?? null };
}

/**
 * S3 bucket naming rules for general purpose buckets: 3–63 characters of lowercase letters,
 * digits, dots and hyphens, starting and ending with a letter or digit. (Dots are allowed by S3
 * but break virtual-hosted TLS; infra never uses them.)
 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const mediaStorageEnvSchema = z.object({
  MEDIA_BUCKET: z
    .string()
    .regex(BUCKET_NAME, { error: 'must be a valid S3 bucket name' })
    .refine((name) => !name.includes('..'), { error: 'must be a valid S3 bucket name' }),
  /** LocalStack needs path-style requests. `true`/`false` (also 1/0, yes/no, on/off). */
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

export interface MediaStorageConfig {
  /** The private media bucket: originals/, derived/ and tmp/ (see s3-keys). */
  bucket: string;
  forcePathStyle: boolean;
}

/** Reads MEDIA_BUCKET (required; api and worker) and S3_FORCE_PATH_STYLE (default false). */
export function loadMediaStorageConfig(env: Env): MediaStorageConfig {
  const e = parseEnv(mediaStorageEnvSchema, env, 'media storage');
  return { bucket: e.MEDIA_BUCKET, forcePathStyle: e.S3_FORCE_PATH_STYLE };
}
