import {
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { BucketApi, Read } from './bucket';

// BucketApi on the AWS SDK, for any S3-compatible endpoint (R2, LocalStack).

/** Error names that mean "the bucket has none". */
const ABSENT = new Set([
  'NoSuchPublicAccessBlockConfiguration',
  'NoSuchBucketPolicy',
  'NoSuchCORSConfiguration',
  'NoSuchLifecycleConfiguration',
]);
/** Error names that mean "this store doesn't implement the call". */
const UNSUPPORTED = new Set(['NotImplemented', 'MethodNotAllowed', 'XNotImplemented']);

function classify(error: unknown): 'absent' | 'unsupported' | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? e.Code ?? '';
  if (ABSENT.has(name)) return 'absent';
  if (UNSUPPORTED.has(name) || e.$metadata?.httpStatusCode === 501) return 'unsupported';
  return null;
}

async function read<T>(call: () => Promise<T>): Promise<Read<T>> {
  try {
    return { state: 'ok', value: await call() };
  } catch (error) {
    const state = classify(error);
    if (state === null) throw error;
    return { state };
  }
}

export interface S3BucketApiOptions {
  bucket: string;
  client: S3ClientConfig;
  /** Path-style endpoint origin for the unsigned probe (`<endpoint>/<bucket>?list-type=2`). */
  endpointUrl: string;
  /** Skip the unsigned probe (LocalStack accepts unsigned requests by default). */
  skipAnonymousProbe: boolean;
}

export function s3BucketApi(options: S3BucketApiOptions): BucketApi {
  const s3 = new S3Client(options.client);
  const Bucket = options.bucket;
  return {
    bucket: Bucket,
    getPublicAccessBlock: () =>
      read(async () => {
        const out = await s3.send(new GetPublicAccessBlockCommand({ Bucket }));
        return out.PublicAccessBlockConfiguration ?? {};
      }),
    getPolicyIsPublic: () =>
      read(async () => {
        const out = await s3.send(new GetBucketPolicyStatusCommand({ Bucket }));
        return out.PolicyStatus?.IsPublic === true;
      }),
    getAclGrants: () =>
      read(async () => {
        const out = await s3.send(new GetBucketAclCommand({ Bucket }));
        return (out.Grants ?? []).map((g) => ({
          ...(g.Grantee?.URI === undefined ? {} : { granteeUri: g.Grantee.URI }),
          ...(g.Permission === undefined ? {} : { permission: g.Permission }),
        }));
      }),
    anonymousListStatus: async () => {
      if (options.skipAnonymousProbe) return { state: 'unsupported' };
      const url = new URL(
        `${encodeURIComponent(Bucket)}`,
        `${options.endpointUrl.replace(/\/$/, '')}/`,
      );
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', '1');
      const res = await fetch(url, { method: 'GET', redirect: 'manual' });
      await res.body?.cancel();
      return { state: 'ok', value: res.status };
    },
    getCors: () =>
      read(async () => {
        const out = await s3.send(new GetBucketCorsCommand({ Bucket }));
        return out.CORSRules ?? [];
      }),
    putCors: async (rules) => {
      await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
    },
    getLifecycle: () =>
      read(async () => {
        const out = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
        return (out.Rules ?? []).map((r) => ({
          ...(r.ID === undefined ? {} : { ID: r.ID }),
          ...(r.Status === undefined ? {} : { Status: r.Status }),
          ...(r.Prefix === undefined ? {} : { Prefix: r.Prefix }),
          ...(r.Filter?.Prefix === undefined ? {} : { Filter: { Prefix: r.Filter.Prefix } }),
          ...(r.AbortIncompleteMultipartUpload?.DaysAfterInitiation === undefined
            ? {}
            : {
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: r.AbortIncompleteMultipartUpload.DaysAfterInitiation,
                },
              }),
          ...(r.Expiration?.Days === undefined ? {} : { Expiration: { Days: r.Expiration.Days } }),
          ...(r.Transitions === undefined ? {} : { Transitions: r.Transitions }),
        }));
      }),
    putLifecycle: async (rules) => {
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket,
          LifecycleConfiguration: { Rules: rules },
        }),
      );
    },
  };
}
