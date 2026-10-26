# ADR 0008: Run on a VPS with Cloudflare R2; keep only Rekognition (and SES) on AWS

- Status: Accepted (the owner's decisions below); the items under "Open questions" are still open
- Date: 2026-10-26
- Supersedes: ADR 0002 decisions 1–2 and its Cognito consequences (rules 3 and 4 stay), ADR 0003
  (EventBridge Scheduler and the `jobs` SQS queue), ADR 0004 (temporary index images in S3)
- Amends: ADR 0005 (Redis), ADR 0006 (tmp lifecycle), ADR 0007 (face deletion mitigations)
- Changes the photo-platform skill sections "Tech stack", "Invariants", "Upload and processing
  pipeline", "Face indexing", "Sharing and downloads", "Admin dashboard", "Infrastructure" and
  "Testing"; the skill is updated when each step lands

## Context

The owner decided to stop running the platform on AWS for cost. The spec was built around ECS
Fargate, RDS, ElastiCache, S3 + CloudFront (flat-rate plan), SQS, EventBridge Scheduler, Cognito,
WAF and CloudWatch. The owner's decisions:

- **Files and media delivery:** Cloudflare R2 (S3-compatible, no egress charge). Media links stay
  signed and expiring. The bucket is never public.
- **Servers:** one VPS in Singapore running everything with Docker Compose (web, api, worker,
  PostgreSQL, Redis), with a daily database backup to R2.
- **Queue:** BullMQ on Redis instead of SQS, keeping the message schemas in `packages/shared`.
- **Login:** the API runs LINE Login and Google sign-in itself, building on the local mode
  (`AUTH_PROVIDER=local`). Admins need MFA (TOTP).
- **Face search:** keep Amazon Rekognition in `ap-southeast-1`, but send image bytes (at most
  5 MiB) instead of S3 objects. `indexPhoto` and tiling must fit that limit, and `face-eval`
  must measure accuracy at the new size.
- Code is not tied to one vendor: storage, queue and auth go through adapters. Work order: queue
  and auth → storage → face → production Docker Compose. `infra/` (AWS CDK) stays until the new
  system runs end to end, and is deleted only with the owner's approval.

Nothing has been deployed to production, so there is no production data to migrate.

## Decision

### 1. Adapters and configuration

Every vendor sits behind an interface, selected by config in one place (`apps/api/src/wiring.ts`
and the worker's equivalent):

| Concern | Interface | Implementations |
|---|---|---|
| Object storage | `ObjectStorage` (api), `ObjectStore` (worker) | S3-compatible client (R2, LocalStack, MinIO, AWS S3) |
| Media URLs | `MediaUrlSigner` | `S3PresignMediaUrlSigner` (R2), `CloudFrontMediaUrlSigner` (until infra/ is removed) |
| Queue | `QueueSender` (api), consumer runtime (worker) | BullMQ; SQS until infra/ is removed |
| Identity | `TokenVerifier` (api), `AuthProvider` (web) | API-issued tokens (LINE, Google, admin password + TOTP, `local` on APP_STAGE=local); Cognito until infra/ is removed |
| Face | `FaceProvider` (packages/face, ADR 0001) | Rekognition with `Image.Bytes` |

- **Endpoints and credentials are explicit per client.** Storage gets its own
  `STORAGE_ENDPOINT_URL`, `STORAGE_REGION` (`auto` for R2) and keys. Rekognition and SES get
  `ap-southeast-1` and their own AWS keys. No client relies on the `AWS_ENDPOINT_URL` environment
  variable or the default credential chain, because AWS SDK v3 applies `AWS_ENDPOINT_URL` to every
  client and would send Rekognition to R2. `MEDIA_URL_SIGNER=s3-presign` stops being local-only;
  outside APP_STAGE=local the loader refuses a storage endpoint on a localhost or loopback host.
- **Client IP.** Today `clientIp()` trusts only CloudFront's `CloudFront-Viewer-Address`. On the
  VPS every request comes from the proxy container, so per-IP rate limits and `consents.ip_hash`
  would collapse to one value. The proxy overwrites (never appends) `X-Forwarded-For` with the TCP
  peer address, and the API trusts that header only when the socket peer is the proxy on the
  compose network. If Cloudflare proxied DNS is enabled, the API trusts `CF-Connecting-IP` only
  while the host firewall admits Cloudflare's ranges only.
- **Client IP through web.** The BFF (`/bff/*`) and server-side rendering call the API from the
  web container and pass the viewer address on (today in `cloudfront-viewer-address`). Web and
  admin take the client address from the proxy's `X-Forwarded-For` and pass it to the API in one
  internal header; the API trusts that header only when the socket peer is the web or admin
  container, and the proxy strips any copy a client sends. The header name changes (a contract
  change in web and api).
- **Proxy routes** mirror CloudFront's behaviours: `/api/*` → api, `/bff/*` and everything else →
  web.

### 2. Storage on R2

- One private media bucket. The `r2.dev` public URL is disabled and no custom domain is attached
  to it. Keys are unchanged (`originals/`, `derived/`, `tmp/`).
- **Uploads:** presigned multipart `UploadPart` URLs, as today. R2 accepts only `STANDARD` and
  `STANDARD_IA` storage classes, so originals are written as `STANDARD` (no Intelligent-Tiering).
  `STANDARD_IA` has retrieval charges and a 30-day minimum; it is a later lifecycle decision.
- **Starting the media pipeline.** R2's S3 API has no `PutBucketNotificationConfiguration`. R2
  event notifications exist but deliver to Cloudflare Queues only; that was rejected to avoid a
  second vendor-specific consumer. Instead:
  - a new `media` message variant (contract change), e.g.
    `{ kind: 'original.completed', fileId, photographerId, key }`, next to the S3 event shape
    (kept until infra/ is removed); `API_QUEUES` gains `media`;
  - the API enqueues it after `markCompleted` commits; an enqueue failure does not fail the
    request;
  - a scheduled `media.sweep` job (new `SCHEDULED_JOB_TYPES` entry) re-enqueues `processing`
    rows not verified after a configured age (a shared config key), and `uploading` rows whose
    multipart upload is gone but whose object exists with the declared size (the API crashed
    between CompleteMultipartUpload and `markCompleted`). That HeadObject check runs before any
    upload-expiry cleanup releases the reservation or deletes the row, so such an object never
    becomes an orphan outside quota.
- **Views and downloads:** SigV4 presigned GET URLs on the R2 S3 endpoint. New behaviour: the
  signing date is rounded down to `SIGNED_URL_EXPIRY_BUCKET_SECONDS`, so one key in one window
  gives one URL and browsers get cache hits (the current signer signs with `now`). URLs live at
  most 7 days (R2 limit). The API signs only keys it built (`parseS3Key`).
- **Content-Disposition:** whether R2 honours `response-content-disposition` on presigned GETs is
  verified against a real bucket before launch. The fallback (storing `Content-Disposition` on
  the object at write time, RFC 5987-encoded for Thai names) goes stale when a file is renamed,
  so it is a last resort.
- **CORS:** `PUT` (uploads, `ETag` exposed) and `GET`/`HEAD` (`navigator.share` fetches signed
  downloads) from the main origin only.
- **Lifecycle:** R2 rules for abort-incomplete-multipart (2 days) and the `tmp/` prefixes of
  ADR 0006, applied by a script in `deploy/` that reads the same config values and re-runs ADR
  0006's checks (they used to run at CDK synth). R2 deletes expired objects up to about a day
  late, so "gone within 3 days" becomes about 4 days. The `tmp/index/` rule is removed (§5).
- **Invariant change.** "Never hand out S3 URLs" existed because S3 egress was billed per GB and
  CloudFront's flat-rate plan was not. R2 egress is free, so the invariant becomes: **never hand
  out an unsigned or non-expiring media URL; the bucket is never public; file bytes never pass
  through the API.** Media becomes cross-origin: the production CSP lists the R2 origin in
  `img-src`/`media-src`/`connect-src`.
- **Attribution:** `bytes_out` keeps coming from `activity_events` written when a URL is issued.
  R2 has no per-request access logs, so re-use of a signed URL within its TTL is not visible, and
  the admin "System" page loses the CloudFront allowance alarms.

### 3. Queue on BullMQ

- One BullMQ queue per current queue (`media`, `faces`, `zip`, `jobs`). For `media`, `faces`
  and `zip`, job data is the serialized shared message (`serializeQueueMessage` /
  `parseQueueMessage`), validated on both sides. Scheduled jobs store only `{ type }` (below). Keys use BullMQ's `prefix` option (`shotx:<stage>:bull`), never ioredis `keyPrefix`.
- SQS semantics map to: `maxReceiveCount` → `attempts` with backoff, plus `maxStalledCount`;
  visibility timeout and heartbeat → lock duration with automatic lock renewal; DLQ → failed
  jobs kept up to a count (`removeOnFail`), with an alert on the failed count (§7).
- **Scheduled jobs** (replaces ADR 0003's EventBridge Scheduler): BullMQ job schedulers
  (`upsertJobScheduler`) with the same job types. The cron patterns move from `infra/cdk.json` to
  shared config in cron-parser syntax with `tz: 'Asia/Bangkok'`. Because scheduler job data is a
  static template and the worker's ledger dedupes on (type, `scheduledTime`), `scheduledTime` is
  taken from the scheduler slot at run time, never from the template; otherwise every run after
  the first would be skipped and retention jobs would silently stop. The worker builds
  `{ type, scheduledTime }` from the job's slot and validates that with the shared schema. BullMQ
  does not backfill slots missed while the VPS is down; the next run catches up because every
  scheduled job is idempotent.
- **Redis (amends ADR 0005):**
  - `noeviction` with an explicit `maxmemory` (the default 0 is unbounded and the kernel's OOM
    killer would end Redis on a box shared with Postgres), and AOF with `appendfsync everysec`
    (up to about 1 s of jobs can be lost on a crash).
  - BullMQ keys have no TTL, an explicit exception to ADR 0005's TTL rule, bounded by
    `removeOnComplete`/`removeOnFail` counts and the events stream `maxLenEvents`.
  - BullMQ runs `INFO` on connect, which the `-@dangerous` ACL blocks; the worker and API set
    `skipVersionCheck`. ADR 0005's ACL was ElastiCache RBAC; on the VPS it is a `users.acl`
    mounted into the compose Redis and tested with BullMQ.
  - Shared fate: a full Redis now also stops upload enqueues, not only caches and rate limits.
- **Lost jobs.** SQS was durable across zones; BullMQ lives in one Redis on one disk. Recovery
  per queue: `media` → `media.sweep`; `zip` → the viewer asks again (a job stuck in `running`
  expires as today); `faces` → a `faces.sweep` job (new `SCHEDULED_JOB_TYPES` entry, or part of
  `media.sweep`) re-enqueues `face_deletions` with `completed_at IS NULL` older than a configured
  age — no reconciliation catches a lost deletion, because the `faces` rows still exist, and a
  deletion asked for under PDPA must happen — and `ready` files in face-enabled folders that were
  never indexed. A lost `unindex.folder` is covered by `faces.expire.daily`, and
  `faces.reconcile.daily` still deletes collection faces without a row.

### 4. Auth issued by the API

- **Users pool** (photographers and viewers): LINE Login and Google, OpenID Connect
  authorization code flow with PKCE, `state` and `nonce`, run by the API with an exact
  redirect-URI allowlist. The web app keeps its BFF and cookie session code; its `AuthProvider`
  talks to the API. ID tokens are verified per provider: Google with its JWKS (issuer
  `https://accounts.google.com` or `accounts.google.com`); LINE web-login ID tokens are HS256
  signed with the channel secret (verify locally or with LINE's verify endpoint). All LINE
  channels stay under one LINE provider, because LINE user ids are scoped per provider. Email and
  password sign-in is dropped: the owner asked for LINE and Google.
- **Admins pool:** email + password (argon2id) + TOTP, always. Accounts are created with an
  operator CLI and stay unusable until TOTP enrolment is confirmed. MFA used to be enforced by
  Cognito; in application code it is guarded by:
  - admins-pool tokens carry `amr` including `otp`, and the admin guard rejects any token without
    it; a test asserts no code path issues an admins token before TOTP succeeds;
  - TOTP replay protection (the last accepted time step is stored);
  - rate limits per account and per IP on password and code attempts, with lockout (anyone who
    knows an admin's email can lock that account; accepted, because another admin can unlock
    it);
  - every admin sign-in, failed or not, written to `audit_log`;
  - recovery by another admin (reset TOTP), audit-logged;
  - 12-hour refresh tokens, as in ADR 0002.
- **Tokens:** short-lived access tokens signed with an asymmetric key **per pool** (so a bug in
  the users flow cannot mint an admins token), with `kid` for rotation, `iss` per pool and `aud`
  per app. Refresh tokens are opaque, stored hashed, rotated on use, and re-use of a rotated token
  revokes the whole family. Refresh tokens live 30 days in the users pool and 12 hours in the
  admins pool. The pool comes from the verified token, never from the request, and
  a users-pool token never gets the `admin` role (ADR 0002 rules 3 and 4 stay).
- **Identities:** the `(pool, subject)` pair stays the identity. `users.cognito_pool/cognito_sub`
  are renamed `auth_pool/auth_subject`, and subjects carry their provider as a prefix
  (`line:<sub>`, `google:<sub>`, `admin:<id>`, `local:<id>`), so provisioning and the admin CHECK
  constraint stay as they are. Local development rows without a prefix become stale (dev data
  only). A person who signs in with both LINE and Google gets two accounts; linking is a later
  feature.
- **Local mode** is a development identity provider of the API, users pool only, refused outside
  APP_STAGE=local (as today). Web stops minting tokens.
- **Admin app:** `apps/admin` does not exist yet (Phase 5). When it does, it runs as a separate
  compose service on its own subdomain, behind the same proxy with an IP allowlist or Cloudflare
  Access in front (decided in Phase 5).

### 5. Face search with image bytes

- Rekognition stays in `ap-southeast-1`. The worker and the API call it with `Image: { Bytes }`
  of at most 5 MiB (5,242,880 bytes; `REKOGNITION_INLINE_MAX_BYTES` in packages/face). Selfies
  were already sent as bytes and stay in memory only.
- `IndexFaces` images and tiles are encoded in memory under 5 MiB with the existing quality-step
  and shrink loop. `FACE_INDEX_MAX_BYTES` (shared, owned by contracts per ADR 0001) changes from
  15 MiB to 5 MiB; `S3TempImageStore`, `REKOGNITION_S3_MAX_BYTES` and `tmp/index/` go away.
- `face-eval` re-runs the Phase 0 evaluation at the new size before thresholds are chosen. If
  accuracy drops, tiling is the first lever.

### 6. Production on one VPS

- `deploy/docker-compose.yml`: a reverse proxy with automatic TLS, `web`, `api`, `worker`,
  PostgreSQL (with `ltree`) and Redis, on a private network. Only the proxy publishes ports
  (Docker-published ports bypass ufw). CPU and memory limits per service and worker concurrency
  settings keep ffmpeg and sharp from starving the API's face search and Postgres.
- **Selfies never touch disk:** the proxy streams `/api/s/*/face-search` and
  `/api/s/*/face-deletion` bodies without buffering them to temporary files (Caddy streams by
  default; with nginx `proxy_request_buffering off`). Request bodies are never logged, and Docker
  logs are rotated. Swap is off (or on the encrypted volume), so selfie buffers in memory are never
  paged to plain disk.
- **Secrets:** an env file on the server, mode 0600, never committed (anyone in the `docker` group
  can still read it through `docker inspect`). Separate R2 tokens for the api, the worker and
  backups, read-only where possible. One AWS IAM user per service, limited to the Rekognition
  actions it needs on `collection/pg-*` (and SES sending for email), with key rotation,
  CloudTrail on and an AWS Budgets alarm, since a leaked long-lived key means unbounded spend.
- **Host:** SSH keys only, no root login, unattended security updates, the VPS volume encrypted at
  rest (provider feature or LUKS).
- **Backups:** daily `pg_dump`, encrypted client-side to an age public key before upload to a
  **separate R2 bucket**, with a token scoped to that bucket only (R2 has no write-only
  permission) and a bucket lock that blocks deletion and overwrite during retention. The age
  private key is never on the VPS, so a compromised VPS can't read past backups or delete them. Recovery point: 24 hours. Payments, consent withdrawals and face deletions from
  the lost window are gone, so the restore runbook re-syncs payments from the gateway and runs
  the quota and face reconciliations. A restore is tested before launch.

### 7. Monitoring and abuse controls (amends ADR 0007)

CloudWatch alarms and WAF go away. Their replacements are required before launch:

- **Alerts** on: the BullMQ failed count and oldest waiting job per queue (replaces DLQ and
  queue-age alarms), Redis memory (replaces ADR 0005's alarm), the `face_deletion.alert` log
  event (ADR 0007), disk, CPU and memory of the VPS, backup success, and an external uptime check.
  Sentry stays for errors. The tool for log-based alerts is an open question.
- **ADR 0007 amendment:** its mitigations "WAF rate rules and CAPTCHA on face deletion" and "a
  CloudWatch alarm on `face_deletion.alert`" are replaced by the API's per-IP/per-share rate limits
  (with real client IPs, §1), Cloudflare Turnstile (a CAPTCHA that doesn't need a WAF) on face
  search and face deletion, and the alert above. Turnstile is shown after a rate-limit hit, not on
  every scan, so the post-race spike isn't slowed (the spec's "CAPTCHA when abused"); the CSP then
  allows `challenges.cloudflare.com` in `script-src` and `frame-src`, an explicit exception to
  "no CDN". The DPO reviews the reduced mitigations together with ADR 0007.

## Consequences

- AWS keeps Rekognition and SES (email); everything else leaves AWS. Media egress is free.
- **New cost and capacity limits** move to the VPS: its own bandwidth quota (originals pulled for
  derivatives, zips read and written back, Rekognition uploads of up to 5 MiB per image plus
  tiles, backups), CPU, and R2 operations (every thumbnail view is a billed Class B operation).
  The admin cost constants (`packages/shared/src/config/cost.ts`) are reworked for R2 storage and
  operations and the VPS; `CLOUDFRONT_PLAN_MONTH` goes away.
- **One VPS is a single point of failure:** no Multi-AZ database, no autoscaling worker. The
  post-race face-search spike must be load-tested on the chosen VPS size.
- **PDPA:** two new processors, Cloudflare (R2) and the VPS provider, need data processing
  agreements. Original photos, derivatives and encrypted database dumps are stored in R2 with
  location hint `apac`, which does not guarantee Singapore (R2 jurisdictions exist only for the
  EU and FedRAMP). Biometric processing stays in Singapore (Rekognition). Encryption at rest that
  AWS KMS gave (RDS, S3, SQS, ElastiCache) is now the VPS volume encryption and R2's own
  encryption. The cross-border transfer notice must name both new processors, and the DPO reviews
  this together with the consent texts and backup retention against data-subject deletion.
- **To verify against real R2 before launch:** `response-content-disposition` on presigned GETs,
  presigned `UploadPart` from a browser with CORS, `ListMultipartUploads`/`AbortMultipartUpload`,
  lifecycle rules.

## Open questions for the owner

1. Is a 24-hour recovery point acceptable for payments, or should WAL archiving to R2 (point-in-
   time recovery) be added? What recovery time is acceptable?
2. Which VPS provider and size, and what is its monthly bandwidth quota?
3. Keep Amazon SES for email, or which replacement?
4. LINE only shares email after LINE approves the permission. Must photographers give a verified
   email at onboarding (renewal reminders, receipts, data-subject contact), or use LINE Official
   Account messages?
5. Which monitoring and log-alerting stack?
6. Put Cloudflare proxied DNS (and its firewall rules) in front of the VPS now, rather than
   later? (Turnstile is required either way, §7.)

## Order of work

1. Queue (BullMQ) and auth (LINE, Google, admin TOTP), including the client-IP change.
2. Storage on R2 (adapters, presigned GET, enqueue on complete and sweep, CORS, lifecycle script).
3. Face (bytes, 5 MiB encoding, tiling, face-eval at the new size).
4. Production Docker Compose, backups, monitoring, and the post-race face-search load test.

Each step is reviewed before it is committed. Nothing is pushed or deployed.
