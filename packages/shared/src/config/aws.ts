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
 * AWS SDK client settings of the AWS stacks (SQS, Rekognition, and S3 when STORAGE_ENDPOINT_URL is
 * unset). Credentials are not part of it: the SDK's default chain reads them (the task role on
 * ECS, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for LocalStack). Never set AWS_ENDPOINT_URL
 * outside LocalStack: AWS SDK v3 applies it to every client (ADR 0008 section 1). Media storage
 * uses loadMediaStorageConfig (storage.ts), which takes STORAGE_* first.
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

// The media bucket and its S3 client (loadMediaStorageConfig) live in storage.ts.
