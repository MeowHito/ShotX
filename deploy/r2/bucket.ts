import {
  type CorsRule,
  type LifecycleRule,
  type ReadLifecycleRule,
  sameCors,
  sameLifecycle,
} from './rules';

// The bucket side of setup-bucket.ts behind a small interface, so the flow is testable without a
// bucket. s3-bucket-api.ts implements it with the AWS SDK.

/**
 * Result of a bucket read: the value, `absent` (the bucket has none: NoSuchCORSConfiguration and
 * the like) or `unsupported` (the store doesn't implement the call: R2 answers NotImplemented
 * for public access block, policy status and ACLs).
 */
export type Read<T> = { state: 'ok'; value: T } | { state: 'absent' } | { state: 'unsupported' };

export interface PublicAccessBlock {
  BlockPublicAcls?: boolean;
  IgnorePublicAcls?: boolean;
  BlockPublicPolicy?: boolean;
  RestrictPublicBuckets?: boolean;
}

export interface AclGrant {
  /** Grantee group URI (`http://acs.amazonaws.com/groups/global/AllUsers`) when a group. */
  granteeUri?: string;
  permission?: string;
}

export interface BucketApi {
  readonly bucket: string;
  getPublicAccessBlock(): Promise<Read<PublicAccessBlock>>;
  /** GetBucketPolicyStatus `IsPublic`. */
  getPolicyIsPublic(): Promise<Read<boolean>>;
  getAclGrants(): Promise<Read<AclGrant[]>>;
  /**
   * HTTP status of an unsigned ListObjectsV2 on the bucket's S3 endpoint, or `unsupported` when
   * it can't be probed (an emulator that ignores auth).
   */
  anonymousListStatus(): Promise<Read<number>>;
  getCors(): Promise<Read<Partial<CorsRule>[]>>;
  putCors(rules: CorsRule[]): Promise<void>;
  getLifecycle(): Promise<Read<ReadLifecycleRule[]>>;
  putLifecycle(rules: LifecycleRule[]): Promise<void>;
}

const PUBLIC_GROUPS = [
  'http://acs.amazonaws.com/groups/global/AllUsers',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers',
];

export interface PublicAccessReport {
  /** Reasons the bucket is or may be made public. Non-empty: refuse to run. */
  problems: string[];
  /** Checks the store couldn't answer, to print as such. */
  unknown: string[];
}

/**
 * Every public-access signal the S3 API can give. Never throws for unsupported calls. A missing
 * Block Public Access configuration is a problem on AWS-like stores (S3, LocalStack) but only
 * unknown on R2, whose S3 API has none (`r2`).
 */
export async function checkPublicAccess(
  api: BucketApi,
  options: { r2: boolean },
): Promise<PublicAccessReport> {
  const problems: string[] = [];
  const unknown: string[] = [];

  const block = await api.getPublicAccessBlock();
  if (block.state === 'ok') {
    const off = (
      ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'] as const
    ).filter((k) => block.value[k] !== true);
    if (off.length > 0) problems.push(`Block Public Access is off for ${off.join(', ')}`);
  } else if (block.state === 'absent' && !options.r2) {
    problems.push('the bucket has no Block Public Access configuration');
  } else {
    unknown.push('Block Public Access (GetPublicAccessBlock)');
  }

  const policy = await api.getPolicyIsPublic();
  if (policy.state === 'ok' && policy.value) problems.push('the bucket policy makes it public');
  if (policy.state === 'unsupported') unknown.push('bucket policy status (GetBucketPolicyStatus)');

  const acl = await api.getAclGrants();
  if (acl.state === 'ok') {
    const open = acl.value.filter(
      (g) => g.granteeUri !== undefined && PUBLIC_GROUPS.includes(g.granteeUri),
    );
    if (open.length > 0) {
      problems.push(
        `the bucket ACL grants ${open.map((g) => `${g.permission ?? '?'} to ${g.granteeUri ?? '?'}`).join(', ')}`,
      );
    }
  } else if (acl.state === 'unsupported') {
    unknown.push('bucket ACL (GetBucketAcl)');
  }

  const anonymous = await api.anonymousListStatus();
  if (anonymous.state === 'ok' && anonymous.value >= 200 && anonymous.value < 300) {
    problems.push(`an unsigned request can list the bucket (HTTP ${anonymous.value})`);
  } else if (anonymous.state !== 'ok') {
    unknown.push('unsigned listing probe (skipped, or the store ignores auth)');
  }
  return { problems, unknown };
}

export interface SetupPlan {
  cors: CorsRule[];
  lifecycle: LifecycleRule[];
}

export interface SetupResult {
  cors: 'unchanged' | 'applied';
  lifecycle: 'unchanged' | 'applied';
  /** Lifecycle rules the bucket had that the plan replaces (e.g. R2's default multipart rule). */
  replacedLifecycle: ReadLifecycleRule[];
}

/**
 * Applies the plan. Put calls replace the bucket's whole CORS or lifecycle configuration, so the
 * result is the same however often it runs; a configuration that already matches is not written.
 * Each one written is read back and compared.
 */
export async function applyPlan(api: BucketApi, plan: SetupPlan): Promise<SetupResult> {
  const read = <T>(r: Read<T>, what: string): T | null => {
    if (r.state === 'unsupported')
      throw new Error(`${api.bucket}: the store does not support ${what}`);
    return r.state === 'ok' ? r.value : null;
  };

  const currentCors = read(await api.getCors(), 'GetBucketCors') ?? [];
  let cors: SetupResult['cors'] = 'unchanged';
  if (!sameCors(currentCors, plan.cors)) {
    await api.putCors(plan.cors);
    const after = read(await api.getCors(), 'GetBucketCors') ?? [];
    if (!sameCors(after, plan.cors)) {
      throw new Error(`${api.bucket}: CORS read back differs from what was written`);
    }
    cors = 'applied';
  }

  const currentLifecycle = read(await api.getLifecycle(), 'GetBucketLifecycleConfiguration') ?? [];
  let lifecycle: SetupResult['lifecycle'] = 'unchanged';
  let replacedLifecycle: ReadLifecycleRule[] = [];
  if (!sameLifecycle(currentLifecycle, plan.lifecycle)) {
    replacedLifecycle = currentLifecycle;
    await api.putLifecycle(plan.lifecycle);
    const after = read(await api.getLifecycle(), 'GetBucketLifecycleConfiguration') ?? [];
    if (!sameLifecycle(after, plan.lifecycle)) {
      throw new Error(`${api.bucket}: lifecycle rules read back differ from what was written`);
    }
    lifecycle = 'applied';
  }
  return { cors, lifecycle, replacedLifecycle };
}
