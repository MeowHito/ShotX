# deploy/

Production on one VPS (ADR 0008 section 6): `docker-compose.yml` and its proxy, Postgres and Redis
configuration, the ops image (`ops/`: migrate, backup, monitor, run-job), the R2 bucket setup
script (`r2/`), the restore runbook ([RESTORE.md](RESTORE.md)) and the face-search load test
([LOADTEST.md](LOADTEST.md)). Unlike `infra/` (AWS CDK), nothing here deploys by itself: the
operator runs every step.

## What the owner provides

- **Domain:** DNS `A`/`AAAA` records for `SHOTX_DOMAIN` pointing at the VPS. Ports 80 and 443 must be
  reachable for the certificate (Let's Encrypt HTTP-01/TLS-ALPN).
- **Admin subdomain (ADR 0010):** the name for the admin app (`SHOTX_ADMIN_DOMAIN` in
  `.env.production`, e.g. `admin.photos.example.com`; `ADMIN_BASE_URL` in `env/common.env` is
  `https://` plus that name), with its own `A`/`AAAA` records to the same VPS before the first
  start. Caddy gets a separate certificate for it.
- **Bootstrap admin:** the person who runs the one-time `create` command below for
  `action.in.th@gmail.com`, types its password and enrols TOTP on their own device.
- **VPS:** size (open question 2; the defaults fit 4 vCPU / 8 GB), with an encrypted volume.
- **Cloudflare R2:** the media bucket and a separate backup bucket with a bucket lock, both with
  location hint `apac`. Tokens: api (Object Read & Write, media bucket), worker (same), an
  optional read-only signing token, backup (Object Read & Write, backup bucket only), and a
  short-lived admin token for `r2/setup-bucket.ts`.
- **AWS (ap-southeast-1):** IAM users `shotx-<stage>-api` and `shotx-<stage>-worker`, limited to the
  Rekognition actions in `env/api.env.example` / `env/worker.env.example` on `collection/pg-*`,
  plus `ses:SendEmail`/`ses:SendRawEmail` from the verified identity. Turn on CloudTrail and an AWS
  Budgets alarm, and rotate the keys.
- **age key pair** for the backups: `age-keygen -o key.txt` on the owner's machine. Only the public
  key (`age1...`) goes into `env/backup.env`. Keep a second, break-glass key offline too and list
  both.
- **Alerts:** a webhook URL (`ALERT_WEBHOOK_URL`) and an external uptime check (below). Optionally a
  heartbeat URL (`MONITOR_HEARTBEAT_URL`).
- **Sign-in and mail:** the LINE Login channel, the Google OAuth client, the Cloudflare Turnstile
  keys and SES sending.
- **Payments:** none for now. `BILLING_MODE=offline` (ADR 0010): photographers pay the owner in
  cash and an admin creates their account. The Omise keys are needed only when the gateway is
  switched on (`BILLING_MODE=gateway`, a later ADR): then uncomment `PAYMENT_GATEWAY` in
  `env/common.env` and the `PAYMENT_OMISE_*` lines in `env/api.env` and `env/worker.env`.

## First deploy

On the VPS, as a non-root user in the `docker` group, with the repository checked out:

```sh
cd deploy
cp .env.production.example .env.production
for f in env/*.env.example; do cp "$f" "${f%.example}"; done
chmod 600 .env.production env/*.env
# Fill in every REPLACE_ME (the services refuse to start while one is left). Generate secrets with
# `openssl rand -base64 48`; signing keys as the comments say.

# Redis ACL from two new passwords (the app's goes into env/api.env and env/worker.env as
# REDIS_PASSWORD, the monitor's into env/monitor.env):
REDIS_APP_PASSWORD=... REDIS_MONITOR_PASSWORD=... \
  docker compose --env-file .env.production run --rm --no-deps -e REDIS_APP_PASSWORD \
  -e REDIS_MONITOR_PASSWORD migrate redis-acl > redis/users.acl
chmod 600 redis/users.acl

docker compose --env-file .env.production build
docker compose --env-file .env.production up -d     # migrate runs before api and worker
docker compose --env-file .env.production ps
```

Then:

- Apply the R2 bucket settings: `r2/setup-bucket.ts` (below), with the admin token.
- Create the bootstrap admin (once; ADR 0010). Run it in the api container, interactively, so
  the password is typed on stdin:

  ```sh
  docker compose --env-file .env.production exec api \
    node dist/cli/admin.js create --email action.in.th@gmail.com --name "<display name>"
  ```

  Never pass the password as an argument or an environment variable, and never write it in any
  file (env files, `.env.production`, shell history, notes in the repository) or a log. The
  password must meet `ADMIN_PASSWORD_MIN_LENGTH` (default 14). The CLI then prints the TOTP
  enrolment once (an `otpauth://` URI and the manual secret): add it to the admin's
  authenticator app right away. Then sign in at `https://<SHOTX_ADMIN_DOMAIN>` with the email,
  the password you typed and a code from the app; the first valid code confirms the enrolment.
  A CLI-created admin is not asked to change the password (it was typed by its owner). If the
  enrolment output is lost, run `node dist/cli/admin.js reset-totp --email ...`. Every other
  account, admin or photographer, is created in the admin app.

- Run one backup now (`docker compose --env-file .env.production run --rm backup backup --once`)
  and the restore test in [RESTORE.md](RESTORE.md) before launch.

Postgres's init script (`postgres/01-init.sh`) only runs on an empty volume. It creates the
extensions (ltree, pg_trgm, vector), the `shotx` role, which owns the database and is not a
superuser, and the `shotx_monitor` role. With an existing volume, create them by hand with the
same SQL. In particular, a volume created before migration 0010 (ADR 0009) needs pgvector
created by the superuser **before** `migrate` runs, because `shotx` may not create it:

```sh
docker compose --env-file .env.production up -d postgres   # the pgvector image (postgres-image/)
docker compose --env-file .env.production exec -T postgres \
  psql -U shotx_admin -d shotx -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector'
```

## Services

| service  | image                  | networks                      | notes                                                              |
| -------- | ---------------------- | ----------------------------- | ------------------------------------------------------------------ |
| proxy    | caddy                  | edge (fixed `SHOTX_PROXY_IP`) | the only published ports (80, 443 TCP/UDP); automatic TLS          |
| web      | apps/web               | edge                          | reads the client address from the proxy's X-Forwarded-For          |
| admin    | apps/admin             | edge                          | `SHOTX_ADMIN_DOMAIN`; calls the api at `http://api:4000` directly  |
| api      | apps/api               | edge, data                    | `TRUSTED_PROXY_ADDRESSES` = the proxy address                      |
| worker   | apps/worker            | data, egress                  | concurrency in `env/worker.env`; `stop_grace_period` ≥ grace + 5 s |
| migrate  | ops                    | data                          | one-off before api/worker: migrations, plan seed, monitor grants   |
| postgres | postgres 18 + pgvector | data                          | ltree, pg_trgm, vector (ADR 0009); `shotx` owns the database       |
| redis    | redis 7.2              | data                          | `noeviction`, `maxmemory`, AOF `everysec`, `users.acl`             |
| backup   | ops                    | data, egress                  | daily at `BACKUP_TIME_UTC`                                         |
| monitor  | ops                    | data, egress                  | checks every minute, alerts to the webhook                         |
| run-job  | ops (profile `tools`)  | data                          | `--profile tools run --rm run-job <type>`                          |

`data` is an internal network: Postgres and Redis can't reach the internet, and nothing outside
can reach them. Every service has CPU and memory limits, a restart policy, rotated logs (Docker's
`local` driver) and `no-new-privileges`. The app containers also drop all capabilities.

**Client IP (ADR 0008 section 1).** On both sites Caddy strips any client-sent `X-Forwarded-For`,
`x-shotx-bff-key`, `x-shotx-client-ip`, `CF-Connecting-IP` and the CloudFront headers. It then sets
`X-Forwarded-For` to the TCP peer. The api trusts that header only from `SHOTX_PROXY_IP`, and trusts
the `x-shotx-client-ip` of web and admin only with a valid BFF key. There are two keys, generated
separately with `openssl rand -base64 48` (different values; the api refuses equal ones):

- `AUTH_BFF_KEY`, web's: in `env/web.env` and `env/api.env`;
- `AUTH_ADMIN_BFF_KEY`, the admin app's: in `env/admin.env` and `env/api.env`.

web never holds the admin key and admin never holds web's, so a leak from one app can't call the
other's routes. The trust is by key, not by address, so the admin container needs no entry in
`TRUSTED_PROXY_ADDRESSES`, which must stay the proxy alone.

**Admin app (ADR 0010).** `SHOTX_ADMIN_DOMAIN` goes to `admin:3001` only. On the main domain Caddy
answers 404 for `/api/admin/*` and `/api/auth/admin/*` (any case, merged slashes, dot segments and
percent-encoding included). The admin app reaches those routes over the edge network through
`API_INTERNAL_URL=http://api:4000`, never through the proxy. The proxy doesn't wait for the admin
app, so a broken admin deploy can't take the main site down: only the admin site answers 502. If Cloudflare's proxied DNS is turned on later
(open question 6), `CF-Connecting-IP` handling and a firewall that admits Cloudflare's ranges
only must come first. Until then, leave it off.

**Selfies.** `/api/s/*/face-search` and `/api/s/*/face-deletion` bodies are streamed to the api:
Caddy never buffers request bodies to disk, and there is no `request_buffers`. Nothing logs bodies.
Caddy's access log drops headers, masks share tokens and query strings, and is rotated with the
other container logs. Swap must be off (or encrypted), so selfie buffers in memory never reach a
plain disk.

## Monitoring (ADR 0008 section 7)

The `monitor` service checks every `MONITOR_INTERVAL_SECONDS` and POSTs JSON to
`ALERT_WEBHOOK_URL` when a check fires or resolves. Firing alerts repeat every
`MONITOR_REPEAT_SECONDS`. Alerts carry counts and row ids only: never names, emails, file names,
faces or IP addresses.

| alert id                                                       | fires when                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `queue.<q>.failed`                                             | a BullMQ queue keeps more than `MONITOR_QUEUE_FAILED_MAX` failed jobs (the DLQ)                            |
| `queue.<q>.age`                                                | its oldest waiting job is older than `MONITOR_QUEUE_MAX_WAIT_SECONDS` (or `MONITOR_<Q>_MAX_WAIT_SECONDS`)  |
| `redis.memory` / `redis.maxmemory`                             | used memory ≥ `MONITOR_REDIS_MEMORY_PERCENT` of maxmemory / maxmemory is 0                                 |
| `files.processing_stuck`                                       | `processing` files the media sweep has stopped re-sending (past `MEDIA_SWEEP_MAX_REQUEUES`)                |
| `faces.deletion_open`                                          | a face deletion is open longer than `MONITOR_FACE_DELETION_MAX_AGE_SECONDS` (1 day, PDPA)                  |
| `faces.deletion_burst`                                         | a share reaches `FACE_DELETION_ALERT_PER_SHARE` deletions in the window (ADR 0007's `face_deletion.alert`) |
| `backup.age`                                                   | no successful backup within `MONITOR_BACKUP_MAX_AGE_SECONDS`                                               |
| `host.memory` / `host.load` / `host.disk.<path>` / `host.swap` | host memory, 5-min load per CPU, the Docker volume disk, swap on                                           |
| `monitor.<check>`                                              | the monitor could not run a check (e.g. the database is down)                                              |

The monitor uses its own Postgres role (SELECT on a few columns of `files` and `face_deletions`
only) and its own Redis user (read-only keys, `INFO` and a handful of read commands). It can't
read personal data or change anything.

**External uptime check (required).** The monitor runs on the VPS, so it can't report the VPS
being down. Configure any external service (UptimeRobot, Better Stack, healthchecks.io, a cron
on another machine) to:

- GET `https://<SHOTX_DOMAIN>/api/health` every minute and expect 200 (the api through the proxy);
- GET `https://<SHOTX_DOMAIN>/healthz` and expect 200 (web);
- GET `https://<SHOTX_ADMIN_DOMAIN>/healthz` and expect 200 (admin);
- alert on a TLS certificate expiring in less than 14 days;
- optionally, expect the monitor's heartbeat (`MONITOR_HEARTBEAT_URL`) at least every 5 minutes.

Errors still go to Sentry (`SENTRY_DSN`).

## Host hardening checklist

Before the first deploy, and re-checked after any provider change:

- [ ] **SSH:** keys only (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`), no root
      login (`PermitRootLogin no`), and a named user for each operator.
- [ ] **Unattended security upgrades** on (`unattended-upgrades` on Debian/Ubuntu), with reboots
      in a maintenance window (`Unattended-Upgrade::Automatic-Reboot-Time`).
- [ ] **Firewall:** default deny inbound; allow 22 (from operator IPs if possible), 80 and 443
      (TCP and UDP). Docker-published ports bypass ufw/iptables INPUT rules, so the only defence is
      that only the proxy publishes. `docker compose config` (and `test/compose.test.ts`) checks
      that. Never add `ports:` to another service; use `docker compose exec` instead.
- [ ] **Swap** off (`swapoff -a`, remove it from `/etc/fstab`), or on the encrypted volume only. The
      monitor alerts while swap is on (`MONITOR_ALLOW_SWAP=false`).
- [ ] **Volume encryption at rest:** the provider's encrypted volume, or LUKS for `/var/lib/docker`
      and the repository checkout.
- [ ] **Secrets:** `deploy/.env.production`, `deploy/env/*.env` and `deploy/redis/users.acl` mode
      0600, owned by the deploy user, never committed (`deploy/.gitignore`). Anyone in the `docker`
      group can read them through `docker inspect`, so keep that group to the operators.
- [ ] **Time:** NTP on (`timedatectl`): signed URLs, tokens and TOTP depend on it.
- [ ] **Docker:** current Engine and Compose; `live-restore` on; no TCP socket exposed.
- [ ] **Backups:** the backup bucket has a bucket lock of at least `BACKUP_RETENTION_DAYS`, the age
      private key is not on the VPS, and the restore test in [RESTORE.md](RESTORE.md) passed.
- [ ] **R2:** the `r2.dev` URL is disabled and no custom domain is connected to either bucket.

## Validating changes

```sh
cd deploy
docker compose --env-file .env.production.example config --quiet   # with env/*.env present
pnpm --filter @shotx/deploy lint typecheck test
```

`test/compose.test.ts` runs `docker compose config` on the example files when Docker is installed.
It checks that only the proxy publishes ports, the trusted proxy address, the api and worker
settings, the admin service (edge network, read-only, API-issued sign-in, internal api URL), the
offline billing settings (no `PAYMENT_*` anywhere), the Redis flags, the limits and the logging.
It also runs every shared loader of web, admin, api, worker, migrate, monitor and backup on the
example env, with the `REPLACE_ME` secrets filled in, and checks that api and admin refuse to
start while they are left. The Caddyfile checks cover the admin site and the `/api/admin/*` 404.

## `r2/setup-bucket.ts`: CORS and lifecycle on the R2 media bucket

ADR 0008 section 2. Applies to an S3-compatible bucket (Cloudflare R2 in production, LocalStack
for a rehearsal):

- **CORS**, main origin only (the origin of `PUBLIC_BASE_URL`):
  - `PUT` with `content-type` allowed and `ETag` exposed (presigned multipart upload parts);
  - `GET`/`HEAD` (the share sheet's `navigator.share` fetches signed downloads; simple requests,
    no credentials).
- **Lifecycle** (ADR 0006): abort incomplete multipart uploads after
  `STORAGE_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS`, and expire `tmp/zips/`, `tmp/reconcile/` and
  the rest of `tmp/` after `STORAGE_TMP_ZIPS_EXPIRATION_DAYS`,
  `STORAGE_TMP_RECONCILE_EXPIRATION_DAYS` and `STORAGE_TMP_OTHER_EXPIRATION_DAYS`. There is no
  `tmp/index/` rule, because IndexFaces gets the image as bytes and nothing is written there
  (ADR 0008 section 5). There is no Intelligent-Tiering transition either (R2 has none).

Everything comes from the environment, read with the `@shotx/shared` loaders:

- the lifecycle days and the CORS max age (`STORAGE_UPLOAD_CORS_MAX_AGE_SECONDS`) through
  `loadStorageLifecycleConfig`. Unset values default to `STORAGE_LIFECYCLE_DEFAULTS`, the values
  the AWS bucket uses;
- the zip, signed-URL, worker and face settings through the same loaders api and worker use. Before anything is sent the script
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
`FACE_ORPHAN_GRACE_MS` fall back to their code defaults when unset, as do the `STORAGE_*` lifecycle
values above. If api and worker use
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

### Rehearsal on LocalStack

With `docker compose` up and the repo's `.env` (`APP_STAGE=local`, `STORAGE_ENDPOINT_URL=http://localhost:4566`):

```sh
set -a; source .env; set +a
pnpm --filter @shotx/deploy r2:setup-bucket
```

This replaces the local bucket's lifecycle rules with the R2 set. The LocalStack init hook keeps
the AWS set, including Intelligent-Tiering. To restore it, run the hook again:
`docker exec <localstack container> bash /etc/localstack/init/ready.d/init-aws.sh`. The CORS rules
are the same in both.

### Tests

`pnpm --filter @shotx/deploy test` covers rule building, the ADR 0006 checks, the public-access
decisions and idempotent apply against a fake bucket. The settings and the ADR 0006 math are
tested in packages/shared (`config/lifecycle.test.ts`), which infra/ uses too.
