import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type Env,
  isR2Host,
  LOCAL_DEV_APP_STAGE,
  loadAppConfig,
  loadFaceConfig,
  loadMediaStorageConfig,
  loadShareConfig,
  loadStorageLifecycleConfig,
  loadWorkerSettings,
  storageS3ClientOptions,
} from '@shotx/shared';
import { applyPlan, checkPublicAccess, type SetupPlan } from './bucket';
import {
  buildCorsRules,
  buildLifecycleRules,
  describeLifecycle,
  lifecycleIssues,
  mainOrigin,
} from './rules';
import { s3BucketApi } from './s3-bucket-api';

// Applies CORS and lifecycle rules to the S3-compatible media bucket (R2 on the VPS, LocalStack
// for a rehearsal). ADR 0008 section 2. See deploy/README.md.

const USAGE = `Usage: pnpm --filter @shotx/deploy r2:setup-bucket [--dry-run]

Reads everything from the environment, the same values api and worker run with: APP_STAGE,
PUBLIC_BASE_URL, ADMIN_BASE_URL, MEDIA_BUCKET, STORAGE_* (including the lifecycle days,
STORAGE_TMP_*_EXPIRATION_DAYS etc., which default to the values the AWS bucket uses) and the zip,
signed-URL, worker and face settings.

  --dry-run   check the configuration and print the rules; no request to the bucket`;

const REMINDER = [
  'Check by hand in the Cloudflare dashboard (the S3 API cannot tell):',
  '  - R2 > bucket > Settings > Public access: the r2.dev URL is disabled;',
  '  - no custom domain is connected to the bucket.',
  'ADR 0008 section 2: the bucket is never public; media is served only through signed URLs.',
].join('\n');

export interface PreparedSetup {
  bucket: string;
  endpointUrl: string;
  r2: boolean;
  local: boolean;
  plan: SetupPlan;
  lifecycleSummary: string[];
  clientOptions: ReturnType<typeof storageS3ClientOptions>;
}

/**
 * Reads and checks everything without touching the bucket. Throws with every problem found.
 * Refuses AWS S3 (no STORAGE_ENDPOINT_URL): that bucket belongs to infra/ (CDK).
 */
export function prepareSetup(env: Env): PreparedSetup {
  const app = loadAppConfig(env);
  const storage = loadMediaStorageConfig(env);
  if (!storage.client.explicit || storage.client.endpointUrl === null) {
    throw new Error(
      'STORAGE_ENDPOINT_URL is not set: this script is for S3-compatible buckets (R2, LocalStack). ' +
        'The AWS media bucket is managed by infra/ (CDK).',
    );
  }
  const settings = loadStorageLifecycleConfig(env);
  const share = loadShareConfig(env);
  const issues = lifecycleIssues(settings, {
    worker: loadWorkerSettings(env),
    shares: [share],
    face: loadFaceConfig(env),
  });
  if (issues.length > 0) {
    throw new Error(`Lifecycle rules would be unsafe (ADR 0006):\n- ${issues.join('\n- ')}`);
  }
  const endpointUrl = storage.client.endpointUrl;
  return {
    bucket: storage.bucket,
    endpointUrl,
    r2: isR2Host(new URL(endpointUrl).hostname),
    local: app.stage === LOCAL_DEV_APP_STAGE,
    plan: {
      cors: buildCorsRules(mainOrigin(app.publicBaseUrl), settings.uploadCorsMaxAgeSeconds),
      lifecycle: buildLifecycleRules(settings),
    },
    lifecycleSummary: describeLifecycle(settings),
    clientOptions: storageS3ClientOptions(storage),
  };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const setup = prepareSetup(process.env);

  console.log(`Bucket ${setup.bucket} on ${setup.endpointUrl}${setup.r2 ? ' (R2)' : ''}`);
  console.log('\nCORS rules:');
  console.log(JSON.stringify(setup.plan.cors, null, 2));
  console.log('\nLifecycle rules:');
  console.log(JSON.stringify(setup.plan.lifecycle, null, 2));
  console.log(`\n${setup.lifecycleSummary.map((l) => `- ${l}`).join('\n')}`);

  if (values['dry-run']) {
    console.log('\nDry run: nothing was sent to the bucket.');
    console.log(`\n${REMINDER}`);
    return 0;
  }

  const api = s3BucketApi({
    bucket: setup.bucket,
    client: setup.clientOptions,
    endpointUrl: setup.endpointUrl,
    // LocalStack accepts unsigned requests unless IAM enforcement is on.
    skipAnonymousProbe: setup.local,
  });
  const access = await checkPublicAccess(api, { r2: setup.r2 });
  for (const what of access.unknown)
    console.log(`Public access: not answered by the store: ${what}`);
  if (access.problems.length > 0) {
    console.error(
      `\nRefusing to continue: ${setup.bucket} allows public access:\n- ${access.problems.join('\n- ')}`,
    );
    return 1;
  }

  const result = await applyPlan(api, setup.plan);
  console.log(`\nCORS: ${result.cors}. Lifecycle: ${result.lifecycle}.`);
  if (result.replacedLifecycle.length > 0) {
    console.log('Replaced lifecycle rules:');
    console.log(JSON.stringify(result.replacedLifecycle, null, 2));
  }
  console.log(`\n${REMINDER}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
