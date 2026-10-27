# ShotX infrastructure (AWS CDK)

Everything runs in `ap-southeast-1`, except what CloudFront requires in `us-east-1`.

| Stack                       | Region         | Contents                                                                                                                                                                                                                 |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ShotX-<stage>-Edge`        | us-east-1      | CloudFront-scoped WAF web ACLs (main, admin) with logging; ACM certificates for both domains                                                                                                                             |
| `ShotX-<stage>-Network`     | ap-southeast-1 | VPC: public (NAT), app (ECS), data (RDS, Redis) subnets; S3 gateway endpoint; optional interface endpoints                                                                                                               |
| `ShotX-<stage>-Registry`    | ap-southeast-1 | ECR repositories `shotx-<stage>/{web,admin,api,worker}` (immutable tags, scan on push)                                                                                                                                   |
| `ShotX-<stage>-Data`        | ap-southeast-1 | RDS PostgreSQL Multi-AZ (TLS forced); ElastiCache Redis Multi-AZ (TLS, RBAC auth with the default user off and `-@dangerous`, `noeviction`, encrypted)                                                                   |
| `ShotX-<stage>-Auth`        | ap-southeast-1 | Cognito users pool (email, Google, LINE OIDC, optional TOTP) and admins pool (TOTP MFA required)                                                                                                                         |
| `ShotX-<stage>-App`         | ap-southeast-1 | Private media bucket, CloudFront log bucket, SQS media/faces/zip/jobs (+ DLQs, alarms), Redis memory alarm, ECS Fargate web/admin/api/worker, internal ALB, CloudFront main + admin distributions, EventBridge Scheduler |
| `ShotX-<stage>-PricingPlan` | us-east-1      | `AWS::PricingPlanManager::Subscription`: CloudFront flat-rate plan for the main distribution                                                                                                                             |

Cross-stack references use `Fn::GetStackOutput` (CDK's recommended "weak" references), including
the cross-region ones. CDK still orders deployments by dependency.

## Commands

```sh
pnpm --filter @shotx/infra synth      # offline: no AWS credentials, no context lookups
pnpm --filter @shotx/infra test       # aws-cdk-lib/assertions invariants
```

Deployment is not automated yet. Never deploy from a laptop with placeholder values.

## Configuration

Every tunable is in the `shotx` object in `cdk.json` (validated by `lib/config.ts`). Fixed platform
facts (regions, path contracts) are in `lib/constants.ts`. Contracts shared with the apps (queue
names, scheduled job types, S3 prefixes, queue env var names, SQS's 12 h visibility cap,
Rekognition's inline image limit) are imported from `@shotx/shared`, never copied;
`test/repo.test.ts` fails if a copy appears in `lib/`.

Override any value from the CLI with `-c shotx:<dotted.path>=<value>`. JSON arrays and objects are
accepted:

```sh
cdk synth -c shotx:account=123456789012 -c shotx:services.imageTag=sha-abc123 \
  -c 'shotx:waf.adminAllowedIpv4Cidrs=["203.0.113.0/24"]'
```

Placeholders to replace before the first deploy: `account`, `domain.*`, `cdn.signingPublicKeyPem`,
`auth.google.clientId`, `auth.line.channelId`, `auth.domainPrefix`, `auth.adminDomainPrefix`,
`alarms.email`, and `network.cloudFrontOriginFacingPrefixListId` (verify it, see below).

## Environment variables the services get

| Variable                                                                                | web | admin | api | worker | Source                                      |
| --------------------------------------------------------------------------------------- | :-: | :---: | :-: | :----: | ------------------------------------------- |
| `NODE_ENV`, `APP_STAGE`, `AWS_REGION`, `PUBLIC_BASE_URL`, `ADMIN_BASE_URL`              |  x  |   x   |  x  |   x    | config                                      |
| `PORT`                                                                                  |  x  |   x   |  x  |        | `services.<name>.containerPort`             |
| `API_INTERNAL_URL`                                                                      |  x  |   x   |     |        | internal ALB                                |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSSLMODE=verify-full`, `PGUSER`, `PGPASSWORD`       |     |       |  x  |   x    | RDS; user/password from Secrets Manager     |
| `REDIS_URL` (`rediss://host:port`, no credentials)                                      |     |       |  x  |   x    | ElastiCache                                 |
| `REDIS_USERNAME`, `REDIS_PASSWORD`                                                      |     |       |  x  |   x    | RBAC user; ECS secrets from Secrets Manager |
| `MEDIA_BUCKET`, `MEDIA_QUEUE_URL`, `FACES_QUEUE_URL`, `ZIP_QUEUE_URL`, `JOBS_QUEUE_URL` |     |       |  x  |   x    | App stack                                   |
| `<QUEUE>_QUEUE_VISIBILITY_TIMEOUT_SECONDS` (`MEDIA_`, `FACES_`, `ZIP_`, `JOBS_`)        |     |       |     |   x    | `queues.<name>.visibilityTimeoutSeconds`    |
| `CLOUDFRONT_MEDIA_BASE_URL`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY`         |     |       |  x  |        | key group; private key from Secrets Manager |
| `COGNITO_USER_POOL_ID`, `COGNITO_WEB_CLIENT_ID`, `COGNITO_DOMAIN`                       |  x  |       |  x  |        | Auth stack                                  |
| `COGNITO_ADMIN_USER_POOL_ID`, `COGNITO_ADMIN_CLIENT_ID`, `COGNITO_ADMIN_DOMAIN`         |     |   x   |  x  |        | Auth stack                                  |
| `FACE_*`, `NODE_EXTRA_CA_CERTS`                                                         |     |       |  x  |   x    | `services.env.backend`                      |
| `FACE_SEARCH_MAX_SELFIE_BYTES`, `FACE_SEARCH_MAX_BODY_BYTES`                            |     |       |  x  |        | derived, see "Face-search uploads"          |
| `MEDIA_BUCKET` (CSP `connect-src` for upload parts)                                     |  x  |       |     |        | App stack                                   |
| `FACE_SEARCH_ENABLED`                                                                   |     |       |  x  |   x    | `features.faceSearchEnabled` (false)        |
| `CONSENT_POLICY_VERSION`                                                                |     |       |  x  |        | `consent.policyVersion`                     |
| `IP_HASH_SECRET`                                                                        |     |       |  x  |        | generated secret; ECS secret                |
| `PAYMENT_GATEWAY`                                                                       |     |       |  x  |   x    | `billing.paymentGateway`                    |
| the gateway's secrets (`PAYMENT_GATEWAY_SECRET_ENV`, e.g. `PAYMENT_OMISE_SECRET_KEY`)   |     |       |  x  |   x    | Secrets Manager JSON keys; ECS secrets      |
| `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`                               |     |       |  x  |   x    | `email.*`                                   |

Extra variables go in `services.env.{common,backend,web,admin,api,worker}`. Derived variables
(face-search limits, queue visibility timeouts, feature flag, consent version, billing and email)
are set after them and can't be overridden; synth rejects `FACE_SEARCH_ENABLED`,
`CONSENT_POLICY_VERSION`, `IP_HASH_SECRET`, `MEDIA_BUCKET`, `PAYMENT_GATEWAY`, every gateway
secret name and `EMAIL_*` in any group. `UPLOAD_*` keys that `loadUploadConfig` reads
(part size, size limits, concurrency) are accepted in `services.env.common` only, so web's
Uppy and the API presigner always agree.
`services.env.backend` sets the `FACE_REKOGNITION_TPS_*` placeholders; `FACE_ORPHAN_GRACE_MS`
keeps its 3 h code default, which synth checks (see "Queue visibility and heartbeats").

`test/env-contract.test.ts` checks every variable above (and every one in `.env.example`) against
the `@shotx/shared` loaders: each must be read by a loader (or by node-postgres, Node or the AWS
SDK), and each service's loaders must accept what the service gets.

Redis clients build their connection from three variables, for example with ioredis:
`new Redis(REDIS_URL, { username: REDIS_USERNAME, password: REDIS_PASSWORD })`. `rediss://`
turns on TLS. Locally (docker compose) Redis has no AUTH and both credentials are empty.

## Routing

CloudFront reaches the internal ALB through a VPC origin; the ALB's security group admits only
the CloudFront origin-facing prefix list (and web/admin tasks calling the API).

| Distribution | Path              | Target                                                      |
| ------------ | ----------------- | ----------------------------------------------------------- |
| main         | `/api/*`          | api (no cache, viewer headers/cookies/query + client IP)    |
| main         | `/media/*`        | S3 via OAC, signed URLs, `/media` stripped by a CF Function |
| main         | `/_next/static/*` | web (cached)                                                |
| main         | default           | web (no cache)                                              |
| admin        | `/api/*`          | api                                                         |
| admin        | `/_next/static/*` | admin (cached)                                              |
| admin        | default           | admin                                                       |

Dynamic behaviours (`/api/*` and default, both distributions) use the origin request policy
`shotx-<stage>-dynamic`: every viewer header, cookie and query string plus
`CloudFront-Viewer-Address` (`ip:port`). CloudFront sets that header from the connection, so a
viewer can't choose it, and only CloudFront (origin-facing prefix list) and the web and admin
tasks can reach the ALB. The api takes the client IP from it (rate limits, `consents.ip_hash`)
and never from `X-Forwarded-For`. Web's server-side API calls arrive from the web tasks without
it unless web forwards the header it received.
Request bodies pass through unchanged, so payment webhook signatures over the raw body verify.

The ALB routes `/api` and `/api/*` to api, then on the `X-ShotX-App` header (`web`/`admin`) that
each distribution sets on its origin requests (CloudFront overwrites any viewer value). Anything
else gets a 404. The API therefore serves all routes under `/api` (for example
`POST /api/s/:token/face-search`), and health checks are `/healthz` (web, admin) and
`/api/health` (api).

`/media/*` responses carry their own headers policy (`cdn.media.responseHeaders`):
`X-Content-Type-Options: nosniff`, HSTS,
`Content-Security-Policy: default-src 'none'; media-src 'self'; sandbox`,
`Referrer-Policy: no-referrer`, and `Access-Control-Allow-Origin: *` (GET/HEAD, never with
credentials). Uploads are served from the main origin, so an object with an HTML or SVG content
type must never run as a page there. CSP doesn't apply to `<img>`/`<video>` in the app's own
pages, the PhotoSwipe lightbox or `response-content-disposition` downloads; it does apply when a
media URL is opened in its own tab (next section).

### Media opened in a new tab

Opening a media URL directly (long-press "open in new tab", a plain link to a `preview.mp4`)
makes the browser wrap it in a synthetic media document that carries the response's CSP.

Verified offline in **Google Chrome 156** (headless, macOS, driven over the DevTools protocol
against a local server sending the `/media/*` headers; Chromium-based browsers, including
Android's LINE in-app browser, use the same engine):

| `/media/*` policy                                                     | MP4 opened in a tab                                                                                 | JPEG  | HTML/SVG upload                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| `default-src 'none'; sandbox` (previous)                              | **broken**: the `<video>` re-fetches the URL and CSP blocks it (`media-src` falls back to `'none'`) | shows | scripts blocked                                             |
| `default-src 'none'; media-src 'self'; sandbox`, no CORS              | **broken**: the sandboxed document's origin is opaque and the fetch fails CORS (`Origin: null`)     | shows | scripts blocked                                             |
| `default-src 'none'; media-src 'self'; sandbox` + `ACAO: *` (current) | plays after a tap (the sandbox flag blocks autoplay)                                                | shows | scripts blocked                                             |
| `... sandbox allow-same-origin`, no CORS (rejected)                   | plays after a tap                                                                                   | shows | scripts blocked, but the document gets the real main origin |

JPEGs always show, because the image document draws the response it already has and makes no
second fetch. The inline styles Chrome uses to center the image are blocked, so it sits unstyled
in the top-left corner. That is cosmetic; `style-src 'unsafe-inline'` would fix it but lets
uploaded HTML style itself, so it is left out.

Why the current policy: it keeps every protection of the previous one. A bare `sandbox` means no
scripts, no forms, no popups and an opaque origin with no cookies. `default-src 'none'` still
blocks every other subresource. The policy adds the minimum the media document needs: it may load
its own media (`'self'` matches the response URL, even in a sandboxed document), and S3 objects
may be read cross-origin without credentials. `Access-Control-Allow-Origin: *` exposes nothing
new: media URLs are bearer URLs (CloudFront signatures in the query string, no cookies), so any
page that knows one can already download it. A per-content-type policy (sandbox only for
non-media types) is not possible in a response headers policy. It would need a viewer-response
CloudFront Function on every media request, which costs more and adds a code path for a case
that this policy already covers.

**Not verified offline**, because neither browser could be automated on the build machine
(Safari's remote automation is off, Firefox isn't installed):

- **Safari / iOS / LINE on iOS (WebKit)**: WebKit's media document also re-fetches the URL from a
  `<video>`, so the previous policy very likely broke playback there too. Whether WebKit matches
  `'self'` in a sandboxed document the way Chrome does is unverified.
- **Firefox**: its video document plays the response it already has, so playback probably worked
  even with the previous policy, and works with this one. Autoplay is blocked by the sandbox flag.

How to check a real browser (staging, or locally with any server that sends the `/media/*`
headers):

1. Get a signed URL of a `derived/.../preview.mp4` and a `web.jpg` from the API.
2. `curl -sI "<url>" -H 'Origin: null'` must show the CSP above,
   `access-control-allow-origin: *`, and no `access-control-allow-credentials`.
3. Open each URL in a new tab in Safari (macOS and iOS), Firefox, Chrome and the LINE in-app
   browser. Expected: the video shows its duration and plays when tapped, the image shows, and the
   console (Safari: Develop menu, Web Inspector) has no CSP or CORS errors for the media URL.
4. XSS side, locally only (never upload HTML to the bucket): serve an HTML file containing
   `<script>document.title='ran'</script>` with the same headers. The title must stay unchanged,
   and the console reports the script blocked by the sandbox.

## WAF

- **Path matching** URL-decodes and then lowercases the path, because the API routes
  case-insensitively and decodes percent-escapes. Face search matches
  `^/api/s/.+/face-search/?$`, so `/api/s/<t>/FACE-SEARCH`, `/api/s/<t>/face-search/` and
  `/api/s/<t>/face%2Dsearch` all hit the face-search limits. Configured paths must be lowercase.
- **Face deletion** (`POST /api/s/:token/face-deletion`, "ขอลบใบหน้าของฉัน") posts selfies like
  face search and shares everything with it: the same per-IP block and CAPTCHA rate rules (one
  budget for both routes, as in the API's `FACE_SEARCH_RATE_*`), the managed-rule body exemption
  and the 413 `Content-Length` rule.
- **Unlock and downloads.** `POST /api/s/:token/unlock` (password guessing) and
  `POST /api/s/:token/downloads` (download URLs and zip jobs) have their own per-IP block rules
  (`waf.unlockBlockRateLimit`, `waf.downloadsBlockRateLimit`), evaluated before the general share
  rules. The API's per-share and per-viewer limits stay the fine-grained ones; these are the
  coarse per-IP backstop. Mobile carriers in Thailand use CGNAT, so keep them generous.
- **Payment webhooks** (`POST /api/billing/webhooks/<billing.paymentGateway>`, the shared
  `BILLING_ROUTES.webhook` path) skip the body-inspecting managed groups like face-search uploads:
  the gateway signs the raw body, and a JSON payload with a URL or HTML in it must still reach
  signature verification. The path is outside the share prefixes, so no CAPTCHA (a gateway can't
  solve one). It has its own per-IP rate rule, `waf.webhookRateLimit` (generous: gateways retry in
  bursts), plus IP reputation and the global rule. `waf.webhookAllowedIpv4Cidrs` (empty by
  default) blocks webhooks from any other address when set to the gateway's published ranges.
  Only the configured gateway's path is exempt; the others get every rule and the API answers 404.
- **Face-search uploads.** Multipart `POST`s to face search skip `AWSManagedRulesCommonRuleSet`
  and `AWSManagedRulesKnownBadInputsRuleSet` (scope-down), whose body rules (XSS, LFI, RFI, SSRF,
  size, Java/Log4j payloads) would read selfie JPEG bytes as text and block real scans. Every
  other request, including non-multipart posts to the same path, still goes through both groups.
  Instead, face-search posts whose `Content-Length` is above `FACE_SEARCH_MAX_BODY_BYTES` get a
  413 with `{ "code": "PAYLOAD_TOO_LARGE" }`. The limit is computed with `loadFaceConfig` from
  the api's environment (14,811,136 bytes at the defaults; 5 MiB is Rekognition's inline image
  limit):

  ```text
  selfie = min(5 MiB, FACE_SELFIE_LONG_EDGE² × waf.faceSearchBody.jpegBytesPerPixel)
  body   = FACE_MAX_SELFIES × selfie + waf.faceSearchBody.multipartOverheadBytes
  ```

  The API gets the same numbers (`FACE_SEARCH_MAX_SELFIE_BYTES`, `FACE_SEARCH_MAX_BODY_BYTES`)
  and must enforce them while reading the upload, because WAF can't check a request that has no
  `Content-Length`.

- **Body inspection limit** (`waf.bodyInspectionLimit`) stays at CloudFront's default of 16 KB.
  Larger limits (up to 64 KB) cost extra per request under standard WAF pricing, and we haven't
  confirmed that the flat-rate plan covers them. Raising it wouldn't help face search: one selfie
  is larger than 64 KB, and the body rules are skipped there anyway. JSON API bodies are well
  below 16 KB. `SizeRestrictions_BODY` (8 KB) stays in Count mode
  (`waf.commonRuleSetCountOverrides`) until the API confirms no other route takes larger bodies.
- **Admin distribution.** It forwards `/api/*` to the same API, so its web ACL blocks the public
  share paths (`/s/*`, `/api/s/*`); otherwise face search would be reachable there without the
  main domain's face-search limits.

## Queue visibility and heartbeats

The worker consumes every queue the same way. When it receives a message it starts a heartbeat:
every third of the queue's visibility timeout (`<QUEUE>_QUEUE_VISIBILITY_TIMEOUT_SECONDS`) it
calls `ChangeMessageVisibility` to push the message's visibility out by one full timeout again,
until the job ends. So the timeout no longer has to cover the longest job. It only decides how
soon a crashed worker's message comes back, and one failed heartbeat never exposes a running job.

| queue   | timeout | heartbeat | max receives | retention | why this timeout                                                                                                                                  |
| ------- | ------: | --------: | -----------: | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media` |   300 s |     100 s |            5 |    4 days | Image derivatives take seconds. A crash delays "ready" by at most 5 min. Video transcodes run longer and rely on the heartbeat (was 900 s).       |
| `faces` |   900 s |     300 s |            5 |    4 days | 5 × 900 s covers the 3960 s worst case with 540 s to spare (600 s would need 7 receives). A crash re-queues the photo within 15 min (was 3600 s). |
| `zip`   |   300 s |     100 s |            3 |     1 day | Someone is polling for the zip. A store-only zip of ≤ 2 GiB streams in about a minute, and a crash retries within 5 min (was 900 s).              |
| `jobs`  |   900 s |     300 s |            3 |     1 day | Batch jobs heartbeat. A crashed hourly rollup reruns within 15 min, well before the next run (was 3600 s).                                        |

Every timeout must be at least 60 s (faces: 180 s), so heartbeats are at least 20 s apart.

The worker also caps each message (`WORKER_<QUEUE>_MAX_PROCESSING_SECONDS`, `loadWorkerSettings`
defaults: media 4 h, faces 2 h, zip 2 h, jobs 6 h). The cap bounds how long heartbeats can hold a
message, so rules 1 and 3 below use it, for every queue. Synth also requires the faces cap ≥ the
faces worst case (3960 s) and the zip cap ≥ the zip worst case: `ZIP_MAX_BYTES` at
`queues.zip.jobBudget.minThroughputBytesPerSecond` plus `processingSeconds` (2 GiB at 10 MiB/s +
60 s = 265 s, which 3 × 300 s also covers for rule 2).

On SIGTERM the worker lets running messages finish for `WORKER_SHUTDOWN_GRACE_SECONDS` (20 s) and
then resets their visibility; the container's `stopTimeout` is that grace plus
`services.worker.stopTimeoutMarginSeconds` (30 s at the defaults, at most Fargate's 120 s).

**The faces job worst case** is computed by `lib/face-limits.ts` from the worker's `FACE_*`
values with `loadFaceConfig`, plus `queues.faces.jobBudget`. At the defaults:

```text
per call = MAX_ATTEMPTS × (MAX_WAIT_MS + REQUEST_TIMEOUT_MS) + (MAX_ATTEMPTS − 1) × RETRY_MAX_MS
         = 8 × (30 s + 10 s) + 7 × 10 s                                      = 390 s
calls    = collectionCallsPerJob (2) + (1 + FACE_TILE_GRID²) IndexFaces (5)
           + 3 DeleteFaces (previous faces on re-index, cut-off tile faces, rollback)  = 10
worst    = 10 × 390 s + processingSeconds (60 s)                             = 3960 s (66 min)
```

Synth fails unless:

1. **worst ≤ 12 h** (43,200 s). SQS caps a message's total invisibility at 12 h from the
   receive, and `ChangeMessageVisibility` can't extend past it.
2. **maxReceiveCount × timeout ≥ worst** (5 × 900 s = 4500 s ≥ 3960 s). Even if heartbeats
   stop, a job that is merely slow is not moved to the DLQ by redeliveries alone. Each
   redelivery starts a duplicate attempt; attempts are idempotent (ADR 0004).
3. **maxReceiveCount × (worst + timeout) ≤ retention** (5 × 4860 s = 6.75 h ≤ 4 days). A message
   that fails every attempt reaches the DLQ before SQS deletes it.
4. **FACE_ORPHAN_GRACE_MS ≥ 2 × worst** (7,920,000 ms). An indexing attempt must commit its
   `faces` rows within half the grace (packages/face `recordFacesDeadline`), or
   `faces.reconcile.daily` could delete faces that are about to be recorded. The code default is
   3 h (10,800,000 ms); an explicit 1 h would fail synth with the default retry budget.

The worker must:

- set its Rekognition SDK request timeout to `FACE_REKOGNITION_REQUEST_TIMEOUT_MS` (10 s) with
  SDK retries off (`maxAttempts: 1`, `withRetry` does the retrying), or bound 1 doesn't hold;
- heartbeat **every** message it has received and not yet finished, including messages from a
  batch receive that are still waiting their turn, with
  `VisibilityTimeout = min(timeout, 43200 − seconds since receive)` (SQS rejects longer
  extensions);
- stop the job when a heartbeat fails with an invalid receipt handle: the message has been
  redelivered and another attempt owns it;
- on SIGTERM (deploys, scale-in) finish within ECS's stop timeout or set the visibility of
  unfinished messages to 0 so they're retried at once;
- for media, zip and jobs, whose worst case has no bound in config (video length, zip size, batch
  size), keep each message under 12 h by splitting work into batches;
- for `faces.reconcile.daily`, not hold the jobs message through the grace period: persist the
  `OrphanScan` and delete its orphans in a later run, at least `FACE_ORPHAN_GRACE_MS` after the
  listing (the daily cadence gives 24 h).

The worker role has `sqs:ChangeMessageVisibility` on every queue it consumes.

## S3 lifecycle (tmp/)

One rule per `tmp/` prefix (ADR 0006). Where rules overlap S3 applies the shortest expiration, so
a single `tmp/` rule would cut zips short. There is no `tmp/index/` rule: IndexFaces gets the
image as bytes (ADR 0008 section 5), so the worker writes no index images to S3.

| prefix           | days | config                               | why                                             |
| ---------------- | ---: | ------------------------------------ | ----------------------------------------------- |
| `tmp/zips/`      |    2 | `storage.tmpZipsExpirationDays`      | must outlive the zip download window (below)    |
| `tmp/reconcile/` |    3 | `storage.tmpReconcileExpirationDays` | worker reconciliation scan files                |
| `tmp/` (rest)    |    3 | `storage.tmpOtherExpirationDays`     | catch-all; must be ≥ every rule above (checked) |

Every rule must be 1–3 days (the spec's range, `TMP_LIFECYCLE_MAX_DAYS`); synth rejects anything
else. `tmp/reconcile/` must also cover one `FACE_ORPHAN_GRACE_MS` plus one daily run (2 days at
the 3 h default, and at the 1-day maximum grace).

Synth fails unless `tmpZipsExpirationDays` days cover the oldest age at which a zip can still be
downloaded. S3 dates a multipart object from its initiation, so:

```text
WORKER_ZIP_MAX_PROCESSING_SECONDS (7200) + ZIP_RESULT_TTL_SECONDS (86400)
  + SIGNED_URL_DOWNLOAD_TTL_SECONDS (600) + SIGNED_URL_EXPIRY_BUCKET_SECONDS (300) = 94500 s -> 2 days
```

Each value is the larger of the api's and the worker's. `loadShareConfig` refuses settings that
would need more than 3 days even at the 11 h worker cap (`ZIP_RESULT_TTL_SECONDS` is at most 2
days), so a valid configuration always fits a 3-day rule.

## Redis

ElastiCache Redis 7.1, Multi-AZ, TLS, RBAC. The default user is off. api and worker connect as
`redis.username` with the access string `on ~* &* +@all -@dangerous`:

- **Allowed:** every command outside `@dangerous`. That covers the read, write, keyspace, string,
  list, hash, set, sorted-set, bitmap, HyperLogLog, geo and stream commands, plus pub/sub,
  transactions, scripting and connection commands. Among them are EVAL/EVALSHA/SCRIPT LOAD (TIME
  inside scripts), LINDEX/LPUSH/LTRIM/PEXPIRE for the rate limiters, GET/SET/EXPIRE/DEL for
  grants, PING and CLIENT SETNAME.
- **Denied (`@dangerous`):** FLUSHALL, FLUSHDB, KEYS, CONFIG, DEBUG, SHUTDOWN, MONITOR, INFO,
  SWAPDB, MIGRATE, RESTORE, REPLICAOF, ACL SETUSER, CLIENT KILL/LIST, SAVE, BGSAVE and the like,
  also when called from a script. Use SCAN, not KEYS. INFO is denied, so ioredis's ready check
  logs a NOPERM warning and is skipped; set `enableReadyCheck: false`.
- `test/redis-acl.integration.test.ts` checks both lists against a real Redis 7 (`REDIS_URL`; CI
  runs it, locally `docker compose up redis`). It uses `ACL DRYRUN` for destructive commands and
  runs the rate limiter's script as the restricted user.

A custom parameter group (family `redis7`) sets `maxmemory-policy noeviction` (ADR 0005): when
memory is full, writes fail instead of rate-limit windows or face_only grants disappearing. The
alarm `shotx-<stage>-redis-memory` fires when the fullest node's `DatabaseMemoryUsagePercentage`
(used_memory / maxmemory) stays above `redis.alarms.memoryUsagePercentThreshold` (75%) for
`redis.alarms.evaluationPeriods` minutes. It notifies the alarm topic. Every key must have a TTL.

## Before the first deploy

1. `cdk bootstrap aws://<account>/ap-southeast-1 aws://<account>/us-east-1`.
2. Secrets Manager (ap-southeast-1), names from `auth.*SecretName` and `secrets.*`:
   - Google OAuth client secret, LINE Login channel secret.
   - CloudFront signing private key. Generate the pair with
     `openssl genrsa -out key.pem 2048 && openssl rsa -pubout -in key.pem -out pub.pem`; put
     `pub.pem` in `cdn.signingPublicKeyPem` and the private key in the secret.
   - Payment gateway (`billing.gatewaySecretName`, unless `billing.paymentGateway` is `fake`): a
     JSON object with one key per `PAYMENT_GATEWAY_SECRET_ENV[<gateway>]` name, each at least 16
     characters. Omise: `PAYMENT_OMISE_PUBLIC_KEY`, `PAYMENT_OMISE_SECRET_KEY`,
     `PAYMENT_OMISE_WEBHOOK_SECRET`; 2C2P: `PAYMENT_2C2P_MERCHANT_ID`, `PAYMENT_2C2P_SECRET_KEY`.
     api and worker read each key as an ECS secret. For `fake` infra generates
     `shotx-<stage>/payment-gateway-fake` with `PAYMENT_FAKE_WEBHOOK_SECRET`.
3. Verify the CloudFront origin-facing prefix list id in ap-southeast-1:
   `aws ec2 describe-managed-prefix-lists --region ap-southeast-1 --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing`.
   The list has ~55 entries and counts against the ALB security group's rule quota.
4. Deploy `Registry`, push the four images (ARM64 by default, `services.cpuArchitecture`), then
   deploy the rest with `-c shotx:services.imageTag=<tag>`.
5. LINE Developers console: add the Cognito callback
   `https://<auth.domainPrefix>.auth.ap-southeast-1.amazoncognito.com/oauth2/idpresponse` and
   apply for the email permission. Google Cloud console: the same callback URL.
6. Cognito sends email with its default sender (low daily limit). Configure SES before launch.
7. Payments and email. The `prod` stage refuses `fake` for `billing.paymentGateway` and
   `email.provider` at synth. Other stages default to `fake`, but every ECS service runs with
   `NODE_ENV=production`, where the shared loaders refuse fake adapters too: synth warns, and api
   and worker won't start until a real gateway and `ses` are configured. Register the webhook URL
   `https://<domain.main>/api/billing/webhooks/<gateway>` in the gateway's dashboard.

## After deploy

- **Flat-rate plan approval.** The `PricingPlan` stack creates a Business subscription in
  `PENDING_APPROVAL`; the distribution is billed pay-as-you-go until someone calls
  `ApprovePaidSubscription` (console, or the PricingPlanManager API in us-east-1) with the
  `SubscriptionArn` output. CloudFormation can't change the tier or usage level: do it in the
  console and then update `cdn.flatRatePlan.tier`. Deleting the stack schedules cancellation at the
  end of the billing period. Set `cdn.flatRatePlan.enabled=false` to manage the plan by hand.
- **WAF CAPTCHA for face search.** Create a CAPTCHA API key for the main domain (WAF console,
  application integration, us-east-1) and give the web app `WAF_CAPTCHA_API_KEY` and
  `WAF_CAPTCHA_SCRIPT_URL`. Without it, face-search calls challenged by the CAPTCHA rule fail
  instead of showing a puzzle.
- **DNS.** With a Route 53 zone (`domain.hostedZoneId`) records and certificate validation are
  automatic. Otherwise create the ACM validation CNAMEs and the CNAME/ALIAS records yourself.

## Before launch

- **Rekognition quotas.** Read each operation's TPS quota (IndexFaces, SearchFacesByImage,
  SearchFaces, DeleteFaces, ListFaces, collection operations) in Service Quotas for
  ap-southeast-1, request increases, and set `FACE_REKOGNITION_TPS_*` in `services.env.backend` to
  ~80% of each quota.
  Then load-test face search for the post-event spike. Keep `services.worker.maxCapacity` in line
  with the IndexFaces quota: extra workers only wait for rate-limit tokens.
- **Alarms.** Set `alarms.email` or subscribe the `AlarmTopicArn` topic to your paging tool.
  `shotx-<stage>-face-deletion-alert` fires on any `{"event": "face_deletion.alert"}` line the api
  logs (ADR 0007), so the api must log JSON with a top-level `event` field.
- **SES sandbox.** New SES accounts are in the sandbox in ap-southeast-1: mail only reaches
  verified addresses, at 200 messages a day. Request production access (SES console, Account
  dashboard) before launch, after the domain identity for `email.fromAddress` is verified (DKIM
  records are automatic when that domain is the Route 53 zone; otherwise add the three CNAMEs
  shown on the identity). Mail goes out through the `shotx-<stage>-email` configuration set
  (the identity's default): reputation metrics, TLS required, bounces and complaints suppressed.
  api and worker may call `ses:SendEmail` on that identity and configuration set only.
- **WAF thresholds.** Venues share IPs (carrier NAT, venue Wi-Fi). Tune `waf.*RateLimit` with
  real traffic; the CAPTCHA tiers trigger before the block tiers.
