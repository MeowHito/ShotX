# API TODO

Items the api agent must pick up when `apps/api` starts. Each one comes from a review finding that
another layer can only partly cover.

## Face search must enforce its own body size limit

- Source: post-Wave-1 review, finding 9.
- WAF rule `face-search-body-too-large` (`infra/lib/stacks/edge-stack.ts`) returns 413
  `PAYLOAD_TOO_LARGE` only when the request has a `Content-Length` header. HTTP/2 and HTTP/3 bodies
  may omit it, and the managed rule groups are skipped on this route, so such uploads reach the API
  unchecked.
- `POST /s/:token/face-search` must:
  - accept `multipart/form-data` only;
  - stream the body and abort with `PAYLOAD_TOO_LARGE` as soon as it passes
    `FACE_SEARCH_MAX_BODY_BYTES`, without buffering the rest;
  - reject any single file over `FACE_SEARCH_MAX_SELFIE_BYTES`, and more than `FACE_MAX_SELFIES`
    files;
  - keep selfies in memory only, and never log them or send them to Sentry.
- Read both byte limits through the shared config loader, never as literals.

## Other notes for the api agent

- Enable strict, case-sensitive routing so paths match the WAF rules.
- Verify tokens from both Cognito pools against their own issuer and client, and never grant admin
  to a users-pool token (ADR 0002).
- Build the Redis client from `REDIS_URL` plus `REDIS_USERNAME` / `REDIS_PASSWORD`.
