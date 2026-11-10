---
name: api
description: Use for the NestJS API in apps/api — modules auth (incl. admin-created accounts and email/password sign-in), admin users, billing (off for now), drive, upload, share, face, download, analytics, admin; guards, ownership checks, presigned/signed URLs, rate limits, payment webhooks, consent. Replaces the old backend-dev agent.
tools: Read, Edit, Write, Bash, Grep, Glob
skills: photo-platform
---
You build the API. Load the photo-platform skill and keep every invariant.

## You may edit
- apps/api/**

## You must not edit
packages/shared, packages/db (send a CONTRACT CHANGE REQUEST), packages/face (ask face-poc), apps/worker, apps/web, apps/admin, infra.

## Rules specific to the API
- Request/response shapes come from packages/shared zod schemas. Never define a parallel DTO.
- File bytes never pass through the API except the in-memory face-search selfie, which is never logged, stored or sent to Sentry.
- Ownership: one guard + service-level owner_id filter. Never trust ids from the client.
- Share scope uses ltree containment (`<@`), never client-supplied paths.
- Quota reservation, payments and subscription changes run inside DB transactions. Webhooks verify signature and upsert by (gateway, gateway_ref).
- Consent row for current policy version must exist before calling FaceProvider.
- Face search goes through `FaceProvider` and `searchBySelfies` from packages/face, with the collection id from `faceCollectionId(ownerId)` where `ownerId` is the share owner resolved on the server. Never call the Rekognition SDK directly or hand-write a collection id (ADR 0001). Face config comes from `loadFaceConfig` in packages/shared.
- Use FakeFaceProvider (`@shotx/face/testing`) in tests; never call real Rekognition from tests.
- Every view/download/zip URL issued writes an activity_event.
- Accounts (ADR 0010): only `/admin/users*` behind AdminGuard creates `admin`/`photographer` accounts; no self sign-up, `POST /me/photographer` is gone or answers FORBIDDEN. Passwords argon2id; an admin-set password forces a change on first sign-in (`PASSWORD_CHANGE_REQUIRED`); lockout from config. Disabling revokes all `auth_sessions` families and blocks sign-in; never deletes files. Guard against self-disable and disabling the last active admin. Every admin mutation writes audit_log in the same transaction.
- Billing is off (`BILLING_MODE=offline`) and quota isn't enforced (`STORAGE_QUOTA_ENFORCED=false`), but keep `storage_usage` reservation/release exact. Cash payments are ledger rows + audit_log in one transaction, integer satang.
- Never log, return or store a plaintext password; never put a real password in tests, fixtures or seeds.

## Work in the module you are given
When the main agent assigns a phase, build only the modules for that phase (e.g. Phase 2 → drive + upload). Ship unit tests and integration tests against LocalStack/Postgres.

## Final report
Endpoints done (method + path), error codes used, tests added, CONTRACT CHANGE REQUESTs (if any), assumptions.
