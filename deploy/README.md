# deploy/

Setup for the VPS deployment (ADR 0008). Unlike `infra/` (AWS CDK), nothing here runs at deploy
time on its own: each script is run by hand by the operator.

## `r2/setup-bucket.ts`: CORS and lifecycle on the R2 media bucket

ADR 0008 section 2. Applies to an S3-compatible bucket (Cloudflare R2 in production, LocalStack
for a rehearsal):

- **CORS**, main origin only (the origin of `PUBLIC_BASE_URL`):
  - `PUT` with `content-type` allowed and `ETag` exposed (presigned multipart upload parts);
  - `GET`/`HEAD` (the share sheet's `navigator.share` fetches signed downloads; simple requests,
    no credentials).
- **Lifecycle** (ADR 0006): abort incomplete multipart uploads after
  `storage.abortIncompleteMultipartUploadDays`, and expire `tmp/zips/`, `tmp/reconcile/` and the
  rest of `tmp/` after their `storage.tmp*ExpirationDays`. There is no `tmp/index/` rule (the VPS
  doesn't write index images, ADR 0008 section 5; leftovers fall under the `tmp/` catch-all) and
  no Intelligent-Tiering transition (R2 has none).

The days and the CORS max age come from `infra/cdk.json` (`context.shotx.storage`), the same values
the AWS bucket uses. The zip, signed-URL, worker and face settings come from the environment, read
with the same `@shotx/shared` loaders api and worker use. Before anything is sent the script
re-runs ADR 0006's checks (CDK synth runs them for the AWS bucket) and stops if one fails:

- `tmp/zips/` covers `WORKER_ZIP_MAX_PROCESSING_SECONDS + ZIP_RESULT_TTL_SECONDS +
SIGNED_URL_DOWNLOAD_TTL_SECONDS + SIGNED_URL_EXPIRY_BUCKET_SECONDS`;
- `tmp/reconcile/` covers `FACE_ORPHAN_GRACE_MS` plus one daily run;
- the `tmp/` catch-all is at least as long as every per-prefix rule.

R2 deletes expired objects up to about a day late, so "gone within 3 days" is about 4 days on R2.

It refuses to run when:

- `STORAGE_ENDPOINT_URL` is unset (that is the AWS bucket, which belongs to `infra/`);
- the bucket allows public access as far as the S3 API can tell: Block Public Access off or
  missing (not on R2, which has none), a public bucket policy, an ACL grant to everyone, or an
  unsigned request that can list the bucket (that probe is skipped on `APP_STAGE=local`, because
  LocalStack accepts unsigned requests).

R2's S3 API can't show whether the `r2.dev` URL is on or whether a custom domain is attached. The
script prints a reminder to check both in the Cloudflare dashboard: the `r2.dev` URL must be
disabled and no custom domain attached.

The script is idempotent. A put replaces the bucket's whole CORS or lifecycle configuration, a
configuration that already matches is left alone, and each one written is read back and compared.
Rules it replaces are printed, for example R2's default "abort multipart uploads after 7 days" rule.

### Environment

Use the same values api and worker run with on the VPS (source their env file), plus:

| Variable                    | Value on R2                                                    |
| --------------------------- | -------------------------------------------------------------- |
| `APP_STAGE`                 | the stage, e.g. `prod`                                         |
| `PUBLIC_BASE_URL`           | the main site, e.g. `https://photos.example.com` (CORS origin) |
| `ADMIN_BASE_URL`            | the admin site (required by the shared app loader)             |
| `MEDIA_BUCKET`              | the bucket name                                                |
| `STORAGE_ENDPOINT_URL`      | `https://<account-id>.r2.cloudflarestorage.com`                |
| `STORAGE_REGION`            | `auto`                                                         |
| `STORAGE_ACCESS_KEY_ID`     | R2 API token access key id (see below)                         |
| `STORAGE_SECRET_ACCESS_KEY` | R2 API token secret                                            |
| `STORAGE_ORIGINALS_CLASS`   | `STANDARD`                                                     |
| `S3_FORCE_PATH_STYLE`       | `true`                                                         |

The zip and signed-URL settings (`ZIP_RESULT_TTL_SECONDS`, `SIGNED_URL_DOWNLOAD_TTL_SECONDS`,
`SIGNED_URL_EXPIRY_BUCKET_SECONDS`), `WORKER_ZIP_MAX_PROCESSING_SECONDS` and
`FACE_ORPHAN_GRACE_MS` fall back to their code defaults when unset. If api and worker use
different env files, run the dry run with each one: the checks need the larger values.

**Token.** Changing bucket CORS and lifecycle needs an R2 API token with admin (bucket settings)
permission on this bucket. The services' object read/write tokens should not be able to do it;
confirm this when the tokens are created. Create a short-lived token for the run and revoke it
afterwards. Never use the backup token.

### Run

From the repo root:

```sh
set -a; source /path/to/shotx.env; set +a
export STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=...   # the admin token for this run

pnpm --filter @shotx/deploy r2:setup-bucket --dry-run   # checks and prints the rules, no requests
pnpm --filter @shotx/deploy r2:setup-bucket             # checks public access, then applies
```

`--config <path>` reads `context.shotx.storage` from another cdk.json. pnpm runs the script in
`deploy/`, so a relative path resolves from there.

### Rehearsal on LocalStack

With `docker compose` up and the repo's `.env` (`APP_STAGE=local`, `STORAGE_ENDPOINT_URL=http://localhost:4566`):

```sh
set -a; source .env; set +a
pnpm --filter @shotx/deploy r2:setup-bucket
```

This replaces the local bucket's lifecycle rules with the R2 set. The LocalStack init hook keeps
the AWS set, including `tmp/index/` and Intelligent-Tiering. To restore it, run the hook again:
`docker exec <localstack container> bash /etc/localstack/init/ready.d/init-aws.sh`. The CORS rules
are the same in both.

### Tests

`pnpm --filter @shotx/deploy test` covers rule building, the ADR 0006 checks, the public-access
decisions and idempotent apply against a fake bucket. `test/infra-parity.test.ts` keeps the ADR
0006 math equal to `infra/lib/worker-limits.ts`. Delete it together with `infra/`. At that point
the lifecycle days also need a new home, because they are read from `infra/cdk.json` today.
