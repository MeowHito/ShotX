import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { httpUrl, secret } from './fields';

const PEM_PRIVATE_KEY =
  /^-----BEGIN (RSA |EC )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END (RSA |EC )?PRIVATE KEY-----\n$/;

const cloudFrontEnvSchema = z.object({
  /** `https://<main domain>/media`: signed media URLs are this plus `/<S3 key>`. */
  CLOUDFRONT_MEDIA_BASE_URL: httpUrl({ path: true, httpsOnly: true }),
  /** The CloudFront public key id, e.g. `K2JCJMDEHXQW5F`. */
  CLOUDFRONT_KEY_PAIR_ID: z
    .string()
    .regex(/^[A-Z0-9]{8,32}$/, { error: 'must be a CloudFront public key id' }),
  /**
   * PEM private key (Secrets Manager on AWS). Literal `\n` sequences are turned into newlines so
   * the key can also be given on one line.
   */
  CLOUDFRONT_PRIVATE_KEY: secret()
    .transform((pem) => pem.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim() + '\n')
    .refine((pem) => PEM_PRIVATE_KEY.test(pem), { error: 'must be a PEM private key' }),
});

/** CloudFront signed URLs for views, downloads and zips (api only). */
export interface CloudFrontSigningConfig {
  /** Without a trailing slash. */
  mediaBaseUrl: string;
  keyPairId: string;
  /** PEM, newline-terminated. Secret: never log it. */
  privateKey: string;
}

/**
 * Reads CLOUDFRONT_MEDIA_BASE_URL, CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY, all required.
 * Error messages never contain the key.
 */
export function loadCloudFrontSigningConfig(env: Env): CloudFrontSigningConfig {
  const e = parseEnv(cloudFrontEnvSchema, env, 'CloudFront signing');
  return {
    mediaBaseUrl: e.CLOUDFRONT_MEDIA_BASE_URL,
    keyPairId: e.CLOUDFRONT_KEY_PAIR_ID,
    privateKey: e.CLOUDFRONT_PRIVATE_KEY,
  };
}
