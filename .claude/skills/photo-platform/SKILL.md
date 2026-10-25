---
name: photo-platform
description: Architecture, settled decisions and business rules for the photo-distribution platform — a Google Drive-like web app where photographers buy storage plans, upload and share photos and videos by link, and event attendees find their own photos by scanning their face (Amazon Rekognition), plus an admin analytics dashboard, built on AWS with Next.js, NestJS and PostgreSQL. Use this skill for ANY work on this project, including writing, reviewing or debugging code, DB schema and migrations, APIs, upload/folder/share/download features, face search, plans, quota and payments, admin metrics and charts, PDPA and consent, AWS infrastructure and cost questions, even when the request doesn't name the project (for example add a rename button, fix the upload bug, ทำหน้าสแกนหน้า, เพิ่มกราฟรายได้แอดมิน, ตั้งราคาแพ็กเกจ).
---
  
# Photo distribution platform

Photographers buy a storage plan, upload photos and videos into a Drive-like folder tree, and share files or folders by link. Anyone with a link can scan their face (live camera or a photo from the device) to see and download the photos they appear in. Admins see revenue and per-photographer usage. The operator is a large company in Thailand: UI copy is Thai, code/comments/commits are English, money is THB.

Three things decide whether this product succeeds. When a design choice trades against them, they win:

1. **Bandwidth cost.** Downloads, not storage, are the expensive part. All media is served through CloudFront on a flat-rate plan.
2. **Face-search accuracy.** Measured on real event photos, never assumed.
3. **PDPA.** A face is biometric data, which is sensitive personal data (PDPA section 26).

## How to work on this project

- Before writing code, find the section below that governs the feature and keep every invariant.
- The decisions here are settled. If a request conflicts with one, say so and propose the change explicitly as an ADR in `docs/adr/` instead of silently deviating.
- When something is underspecified, pick the option most consistent with these rules and state the assumption in your summary or PR description.
- All tunables (thresholds, limits, prices, retention, cost constants) live in config or the DB, never as literals in code.
- User-facing strings go through i18n (`th` default). The client maps API error codes to Thai messages.
- Ship tests with every feature (see Testing).

## Roles

| Role | Can do |
|---|---|
| `photographer` | Buy/renew a plan, full CRUD on own drive, create and revoke shares, see own stats |
| `user` (viewer) | Open share links (anonymous, or LINE/Google login when the share requires it), scan face, download what the share allows |
| `admin` | Read across all tenants, manage plans and prices, take down files/shares. MFA required; every action audit-logged |

Enforce ownership server-side in one place (NestJS guard plus service-level `owner_id` checks). Never trust an owner or photographer id sent by the client.

## Tech stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm + Turborepo, TypeScript strict |
| Web (studio + share page) | Next.js App Router, Tailwind, shadcn/ui, TanStack Query, next-intl |
| Admin | Separate Next.js app on its own subdomain, Apache ECharts |
| Upload | Uppy + `@uppy/aws-s3` (multipart, presigned URLs) |
| Gallery | TanStack Virtual (virtualized grid), PhotoSwipe (lightbox) |
| API | NestJS + Drizzle ORM; zod schemas from `packages/shared`; OpenAPI → generated client |
| Background jobs | SQS (each queue with a DLQ) → worker service (sharp, ffmpeg, archiver); EventBridge Scheduler for cron |
| Database | PostgreSQL on RDS Multi-AZ with `ltree`; Redis (ElastiCache) for cache, rate limits, short-lived grants |
| Media | S3 (private) + CloudFront flat-rate Business plan, OAC, signed URLs |
| Face AI | Amazon Rekognition behind a `FaceProvider` interface |
| Auth | Amazon Cognito; Google and LINE Login as OIDC providers; MFA for admins |
| Payments | Thai gateway with PromptPay QR, cards and signed webhooks (e.g. Omise/Opn, 2C2P, Stripe) |
| Infra / ops | ECS Fargate, AWS CDK (TypeScript), GitHub Actions, CloudWatch, Sentry |
| Region | `ap-southeast-1` (Singapore) for everything: Rekognition runs there and only reads S3 objects in its own region |

Validate early that Cognito accepts LINE Login's ID tokens. If it doesn't, run the LINE OAuth flow in the API and link the LINE identity to the app user.

## Repository layout

```
apps/
  web/       Next.js: /studio (photographer), /s/[token] (share page)
  admin/     Next.js: admin dashboard (separate deploy, MFA)
  api/       NestJS modules: auth, billing, drive, upload, share, face, download, analytics, admin
  worker/    SQS consumers (media, faces, zip) and scheduled jobs
packages/
  db/        Drizzle schema, migrations, seed (plans)
  shared/    zod schemas, types, error codes, constants
  ui/        shared shadcn components
infra/       AWS CDK stacks
docs/adr/    architecture decision records
```

## Invariants

- **File bytes never pass through the API.** Uploads use presigned S3 multipart URLs; views and downloads use CloudFront signed URLs. API instances stay small, and big uploads can resume.
- **Never hand out S3 URLs.** Buckets are private (Block Public Access on) and reachable only through CloudFront OAC. S3→CloudFront transfer is free and CloudFront transfer is covered by the flat-rate plan, while direct S3 egress is billed per GB.
- **Heavy work is async.** Image/video processing, face indexing and zipping run in the worker via SQS. Face *search* is the only synchronous AI call, and it is bounded and rate-limited.
- **Selfies are never persisted** — not in S3, the DB, logs or Sentry. Process in memory and discard. Exclude face-search request bodies from all logging and error reporting.
- **No scan without consent.** A `consents` row for the current policy version must exist for the viewer or session before any call to Rekognition.
- **Tenant isolation.** Every drive query filters by `owner_id`; share access is checked with `ltree` path containment, never by trusting paths from the client.
- **Money and quota change inside DB transactions.** Payment webhooks are verified and idempotent. Money is stored as integer satang.
- **No InsightFace pretrained models** (buffalo_l, antelopev2, …). Their license is non-commercial research only. Face recognition goes through `FaceProvider` → Rekognition unless a commercially licensed model is approved by ADR.

## Data model (PostgreSQL)

```
users            id, email, name, role(photographer|admin|user), cognito_sub, created_at
plans            id, code, name, quota_bytes, price_month_satang, price_year_satang, is_active
subscriptions    id, photographer_id, plan_id, status(trial|active|grace|expired|purged),
                 billing(prepaid|auto_renew), period_end, cancel_at_period_end
payments         id, subscription_id, amount_satang, vat_satang, method(promptpay|card),
                 gateway, gateway_ref, status, paid_at          UNIQUE(gateway, gateway_ref)
storage_usage    photographer_id PK, used_bytes, reserved_bytes

folders          id, owner_id, parent_id, name, path ltree (GiST index),
                 face_index_enabled, face_index_expires_at, deleted_at
files            id, owner_id, folder_id, name, mime, size_bytes, sha256,
                 s3_key, thumb_key, preview_key, web_key, width, height, taken_at,
                 status(uploading|processing|ready|failed), face_count, deleted_at
faces            id, file_id, owner_id, rekognition_face_id UNIQUE, bbox jsonb, confidence

shares           id, owner_id, target_type(file|folder), target_id, token UNIQUE,
                 mode(gallery|face_only), allow_download, download_size(web|original),
                 require_login, password_hash, expires_at, is_active, created_at
consents         id, share_id, viewer_id?, anon_id?, policy_version, ip_hash, accepted_at
face_feedback    id, share_id, file_id, similarity, verdict(not_me), created_at

activity_events  id, type(view|scan|download|zip), share_id, file_id, photographer_id,
                 viewer_id?, anon_id?, bytes, created_at        partitioned by month
daily_stats      date, photographer_id, visitors, scanners, scans, downloads,
                 unique_downloaders, bytes_out                  PK(date, photographer_id)
audit_log        id, actor_id, action, target_type, target_id, meta jsonb, created_at
```

- `ltree` labels must be label-safe: use the folder id with `-` replaced by `_`. Moving a folder is one transaction that rewrites the subtree prefix; reject moving a folder into its own descendant.
- Trash is soft delete (`deleted_at`). Trashed files still count toward quota until purged; auto-purge after 30 days.
- `activity_events` grows fast: monthly partitions plus an hourly rollup into `daily_stats`. Dashboards read rollups only, never raw events.

## Upload and processing pipeline

1. `POST /uploads/init` validates extension and declared MIME against the allowlist (JPEG, PNG, WebP, MP4, MOV) and the per-file size limit, then **reserves quota** in one transaction (`used + reserved + size <= quota`, else `QUOTA_EXCEEDED`). It creates the `files` row (`uploading`) and returns presigned part URLs.
2. The client uploads parts straight to S3 with Uppy (4–6 in parallel). Folder drag-and-drop keeps relative paths; create the folders first.
3. `POST /uploads/:id/complete` completes the multipart upload. `DELETE /uploads/:id` aborts it and releases the reservation.
4. S3 `ObjectCreated` → SQS → worker. The worker must be idempotent because SQS delivers at least once:
   - HeadObject plus magic-byte sniffing; on mismatch delete the object, mark `failed`, release the reservation.
   - Move the bytes from `reserved_bytes` to `used_bytes`.
   - Images: `thumb.webp` (400 px), `preview.webp` (2048 px), `web.jpg` (long edge 2560, quality 85 — the "social size" download). Apply EXIF orientation, strip all metadata including GPS from derivatives, read `taken_at` from EXIF.
   - Videos: `poster.jpg` plus a 720p H.264 MP4 preview with `+faststart`. No face indexing for video in the MVP.
   - If the folder has face indexing enabled, enqueue a `faces` job. Mark the file `ready`.
5. S3 lifecycle rules: abort incomplete multipart uploads after 2 days; expire `tmp/` objects after 1–3 days.
6. HEIC: sharp's prebuilt binaries can't decode it, so convert on the client or reject in the MVP. RAW files: reject in the MVP with a clear message.

S3 keys always contain the photographer id so storage and bandwidth can be attributed from CloudFront standard logs:

```
originals/{photographerId}/{fileId}/{originalName}                                         Intelligent-Tiering
derived/{photographerId}/{fileId}/thumb.webp|preview.webp|web.jpg|poster.jpg|preview.mp4   Standard
tmp/index/{fileId}.jpg    tmp/zips/{jobId}.zip                                             lifecycle-expired
```

## Face indexing (worker)

- One Rekognition collection per photographer (`pg-{photographerId}`) with `ExternalImageId = fileId`, so moving or renaming never requires re-indexing.
- Index from a temporary JPEG (long edge ~3,500 px, quality 90, under 15 MB) written to `tmp/index/` and passed as an S3 object.
- Call `IndexFaces` with `MaxFaces = 100` and `QualityFilter` from config (start with `LOW`: event photos are often slightly blurred; tune in the PoC). Store every returned face in `faces`.
- Group shots with small faces: when the response lists unindexed faces with `SMALL_BOUNDING_BOX` or `EXCEEDS_MAX_FACES`, or a cheap local detector (OpenCV YuNet, commercially usable) finds faces narrower than ~2% of the image width, also index 2×2 tiles with ~15% overlap. Duplicate faces across tiles are harmless because results are grouped by file; de-duplicate by IoU only when computing `face_count`.
- A Redis token bucket shared by all workers keeps calls under the account's Rekognition TPS quota (the default is low; request an increase before launch). Retry `ThrottlingException` with jittered backoff.
- Purging files calls `DeleteFaces` in batches. A scheduled job deletes faces for folders past `face_index_expires_at` (default: last upload + 90 days, extendable by the photographer).

## Face search (share page)

1. Consent screen (Thai, versioned) → `POST /s/:token/consent`.
2. Capture with `getUserMedia`, falling back to `<input type="file" accept="image/*" capture="user">` because LINE and Facebook in-app browsers often block the camera API. "Choose from gallery" is allowed only in `gallery` mode.
3. Client-side quality gate with MediaPipe Face Detector: exactly one face, large enough, bright enough. Guide the user in Thai (หันหน้าตรง ถอดแว่นดำ/แมสก์ อยู่ในที่สว่าง). Optionally collect up to 3 angles (front, slightly left, slightly right). Downscale to at most 1280 px JPEG before upload.
4. `POST /s/:token/face-search` (multipart, kept in memory): rate-limit per IP, per share and per viewer; WAF CAPTCHA when abused.
5. For each selfie call `SearchFacesByImage` on the photographer's collection with `FaceMatchThreshold = FACE_MAYBE` and `MaxFaces` around 1000. Rekognition matches the largest face in the input image.
6. Expansion: take the top `FACE_EXPANSION_SEEDS` matches with similarity ≥ `FACE_STRONG` and call `SearchFaces` with each FaceId; union the results. This recovers profile and far-away shots that a selfie misses.
7. Map face ids → `faces` → `files`. Keep only files that are `ready`, not deleted, and inside the share scope (the shared file itself, or `folder.path <@ share_root.path`). Group by file with the max similarity, then bucket into `strong` (≥ `FACE_STRONG`) and `maybe` (≥ `FACE_MAYBE`).
8. Return file ids with signed thumb/preview URLs. Never return other people's face ids or bounding boxes.
9. In `face_only` mode, store the matched file ids as a server-side grant in Redis (keyed by viewer session, TTL 24 h). Every view or download in that share must be in the grant.
10. Log one `scan` activity event with counts only, then discard the image bytes.

Config defaults (the PoC decides the real values): `FACE_STRONG = 95`, `FACE_MAYBE = 85`, `FACE_MAX_SELFIES = 3`, `FACE_EXPANSION_SEEDS = 2`, `FACE_SEARCH_RATE = 10 per IP per 10 min`.

The UI shows two groups, "ใช่คุณ" and "อาจจะเป็นคุณ", plus a "ไม่ใช่ฉัน" button that writes `face_feedback` (no biometrics) for threshold tuning.

### Accuracy program

Build the evaluation harness before the product UI: one real event plus 20–30 volunteers with ground-truth labels. Report precision and recall per threshold and per pipeline option (index resolution, `QualityFilter`, tiling, expansion on/off). Re-run it whenever face-pipeline code changes. In production, track the share of scans with zero results and the "ไม่ใช่ฉัน" rate.

## Sharing and downloads

- Token: 128-bit random, base62 (~22 chars), URL `/s/{token}`. Options: password (argon2id; unlocking sets a share-scoped cookie), expiry, `require_login`, revoke via `is_active`.
- Share page: SSR with OG tags (cover = a preview image) so links unfurl in LINE and Facebook. Mobile-first, virtualized grid, cursor pagination (~100 items per page), signed URLs generated per page (previews ~1 h TTL, downloads ~10 min).
- `download_size = web` serves `web.jpg`; originals only when the share allows them.
- Single download: signed URL with `Content-Disposition: attachment` and the original filename.
- Multiple files: a zip job in which the worker streams objects into a ZIP with **store (no compression)** — JPEG and MP4 don't compress further — and writes it to `tmp/zips/`; the client polls the job and receives a signed URL. Max files and bytes per zip come from config.
- On iOS offer the Web Share API (`navigator.share({ files })`) so people can save several photos straight to Photos; ZIP files are awkward on iPhone.
- Every issued view, download and zip URL writes an `activity_event`.

## Plans, quota and billing

Seed plans (prices include 7% VAT; editable by admins):

| code | quota | THB / month | THB / year |
|---|---|---|---|
| starter | 10 GB | 149 | 1,490 |
| standard | 50 GB | 390 | 3,900 |
| pro | 200 GB | 990 | 9,900 |
| studio | 500 GB | 2,290 | 22,900 |

Trial: 2 GB for 14 days, face search included.

- Quota counts originals only, trash included. Derivatives are absorbed by the pricing.
- Subscription lifecycle, driven by a daily scheduled job with email reminders at T-14, T-7 and T-1:
  - `trial` / `active`: full access.
  - `grace` (14 days after `period_end`): uploads blocked; shares and downloads keep working.
  - `expired`: shares show "ลิงก์นี้หมดอายุ"; the photographer can still log in, renew and download their own files.
  - `purged` (45 days after expiry, configurable 30–60): delete S3 objects and the Rekognition collection; keep billing records.
- Upgrade takes effect immediately with a prorated charge. Downgrade applies at period end; if usage exceeds the new quota, block uploads until it fits. Never auto-delete user files on downgrade.
- PromptPay buys prepaid periods (1, 3, 6 or 12 months); cards auto-renew. Webhooks: verify the signature, upsert by `(gateway, gateway_ref)`, apply inside a transaction.
- Fair use lives in the Terms; alert admins when an account's monthly egress is anomalous (e.g. above 20× its stored bytes).
- Notifications by email; LINE Official Account messages (Messaging API) are optional. LINE Notify has been discontinued — don't use it.
- Later phase: full tax invoices (ใบกำกับภาษีเต็มรูป) for business customers.

## Admin dashboard

All pages read from rollups; charts use ECharts.

- **Revenue**: MRR (monthly equivalent of active subscriptions, ex-VAT), revenue by month (bar), plan mix (donut), new vs churned (line), ARPU.
- **Photographers**: leaderboard sortable by downloads, unique downloaders, scans, visitors and storage used. Drill-down: shares, funnel (visitors → scanners → downloaders), top photos, bytes served, and estimated cost vs revenue (profit per account) to find loss-making accounts.
- **System**: total storage, CloudFront usage against the plan allowance (50 TB transfer, 125M requests; alarm at 50% and 80%), Rekognition calls and estimated cost, queue depth, DLQ size, error rates.
- **Moderation**: reports queue, takedowns (disable file or share), audit log viewer.

Counting people: use `viewer_id` when logged in, otherwise a first-party `anon_id` cookie (1 year). Shares with `require_login` give exact counts.

Cost constants for "estimated cost" (config; update when AWS prices change; USD): `S3_STANDARD_GB_MONTH = 0.025`, `REKOGNITION_CALL = 0.001`, `REKOGNITION_FACE_MONTH = 0.00001`, `CLOUDFRONT_PLAN_MONTH = 200` (allocated by each photographer's share of bytes served), `USD_THB = 33`.

## Infrastructure

- One CloudFront distribution for the main domain on the flat-rate Business plan: `/api/*` → ALB (API, no caching), `/media/*` → S3 via OAC (signed URLs, long cache), default → web app. Use OAC, not OAI (OAI is unsupported on flat-rate plans), and standard access logs (real-time logs are unsupported). WAF rate-based rules and CAPTCHA protect `/s/*` and face search. The admin app gets its own pay-as-you-go distribution; its traffic is tiny.
- Plan allowances aren't hard caps: there are no overage charges, but sustained excess can degrade delivery. Move to Premium when sustained usage approaches the allowance.
- VPC with private subnets for ECS, RDS and Redis; an S3 gateway endpoint so S3 traffic doesn't pay NAT processing.
- ECS Fargate services `web`, `admin`, `api`, `worker`; the worker autoscales on SQS queue depth.
- Queues `media`, `faces`, `zip`, each with a DLQ and alarms.
- Scheduled jobs (EventBridge Scheduler → worker): hourly stats rollup; daily subscription transitions, trash purge and face-index expiry; nightly quota reconciliation against S3.
- Before launch: raise the Rekognition TPS quota and load-test face search for the post-race spike when thousands of people scan at once.

## PDPA and security checklist

- Consent recorded per share and session with the policy version; withdrawal supported.
- Turning on face search for a folder requires the photographer to confirm attendees were informed (organiser notice or registration consent).
- Selfies discarded; no biometrics in logs; face index auto-expires; a public "ขอลบใบหน้าของฉัน" flow lets a person scan and delete their matched faces from that photographer's collection.
- Data-subject requests for photographer accounts: export and delete.
- Admins: MFA, separate app, audit log for every action.
- Passwords hashed with argon2id; tokens from a CSPRNG; zod validation at every API boundary; magic-byte checks in the worker; CSP headers.
- The company's DPO or legal team reviews consent text and retention periods before launch.

## API conventions

- REST with cursor pagination. Errors are `{ code, message, details }` with stable codes (`QUOTA_EXCEEDED`, `SHARE_EXPIRED`, `CONSENT_REQUIRED`, `NO_FACE_DETECTED`, `RATE_LIMITED`, …); the web app maps codes to Thai messages.
- `Idempotency-Key` header on payment and zip creation.
- Core routes:

```
drive     GET /drive/folders/:id/children   POST /drive/folders   PATCH /drive/folders/:id
          PATCH /drive/files/:id   POST /drive/items/trash   POST /drive/items/restore   DELETE /drive/trash
upload    POST /uploads/init   POST /uploads/:id/complete   DELETE /uploads/:id
share     POST /shares   PATCH /shares/:id   GET /shares/:id/stats
public    GET /s/:token   GET /s/:token/items   POST /s/:token/unlock   POST /s/:token/consent
          POST /s/:token/face-search   POST /s/:token/downloads   GET /zip-jobs/:id
billing   GET /plans   POST /billing/checkout   POST /billing/webhooks/:gateway
admin     GET /admin/metrics/revenue   GET /admin/photographers   GET /admin/photographers/:id
          GET /admin/system   POST /admin/takedowns
```

## Build order

Finish each phase with tests and a demo before starting the next.

0. **Face PoC**: evaluation harness, report, chosen thresholds. If this fails, nothing else matters.
1. **Foundations**: monorepo, CDK stacks, Cognito auth and roles, DB migrations, CI.
2. **Drive**: upload pipeline, derivatives, folders, rename and move, trash, restore, purge.
3. **Sharing, face search, downloads**: share page, consent, search, zip.
4. **Billing**: plans, checkout, webhooks, quota enforcement, subscription lifecycle.
5. **Admin**: rollups, dashboards, moderation, audit log.
6. **Extras**: watermarked previews, `face_only` mode with Rekognition Face Liveness, per-photo sales with a platform commission, tax invoices.

## Testing

- Unit: quota reservation and release, `ltree` scope checks (including moved folders and trash), the subscription state machine, webhook idempotency, threshold bucketing.
- Integration: S3/SQS flows against LocalStack; Rekognition through a fake `FaceProvider` with deterministic matches.
- E2E (Playwright, mobile viewport): upload → share → consent → scan → download.
