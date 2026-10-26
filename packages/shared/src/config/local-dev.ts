// Development-only replacements for the managed services a laptop doesn't have (Cognito). Each
// is refused anywhere but APP_STAGE=local with a non-production NODE_ENV: an allowlist, so a
// mistyped stage name can never enable them.
//
// The auth stand-in (AUTH_PROVIDER=local) lives in auth.ts. MEDIA_URL_SIGNER moved to storage.ts:
// since ADR 0008 `s3-presign` is allowed on every stage (R2), not only locally.

export { LOCAL_DEV_APP_STAGE } from './stage-gate';
