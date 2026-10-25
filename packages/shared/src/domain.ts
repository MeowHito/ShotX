// Value sets of the status, role and mode columns in the data model. packages/db builds its
// PostgreSQL enums from these, and API schemas use them, so the two never drift apart.

export const USER_ROLES = ['photographer', 'admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * The Cognito user pool an identity comes from. `users` holds photographers and viewers,
 * `admins` holds admins only (MFA required). A `sub` is unique only within its pool.
 */
export const AUTH_POOLS = ['users', 'admins'] as const;
export type AuthPool = (typeof AUTH_POOLS)[number];

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'grace', 'expired', 'purged'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_MODES = ['prepaid', 'auto_renew'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const PAYMENT_METHODS = ['promptpay', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** `expired` is an unpaid PromptPay QR that timed out. */
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'expired', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FILE_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * What a share points at. Exactly one of `shares.target_file_id` and `shares.target_folder_id` is
 * set, the one matching the type.
 */
export const SHARE_TARGET_TYPES = ['file', 'folder'] as const;
export type ShareTargetType = (typeof SHARE_TARGET_TYPES)[number];

export const SHARE_MODES = ['gallery', 'face_only'] as const;
export type ShareMode = (typeof SHARE_MODES)[number];

/** `web` serves web.jpg; `original` serves the uploaded file. */
export const DOWNLOAD_SIZES = ['web', 'original'] as const;
export type DownloadSize = (typeof DOWNLOAD_SIZES)[number];

export const FACE_FEEDBACK_VERDICTS = ['not_me'] as const;
export type FaceFeedbackVerdict = (typeof FACE_FEEDBACK_VERDICTS)[number];

export const ACTIVITY_TYPES = ['view', 'scan', 'download', 'zip'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * Zip download jobs (`zip_jobs.status`): `queued` until a worker claims it, `running` while it
 * streams, then `ready` (the archive is in tmp/zips/) or `failed`.
 */
export const ZIP_JOB_STATUSES = ['queued', 'running', 'ready', 'failed'] as const;
export type ZipJobStatus = (typeof ZIP_JOB_STATUSES)[number];

/**
 * Where an activity event comes from (`activity_events.source`): `share` for everything a share
 * link serves (views, scans, downloads, zips; `share_id` set), `owner` for downloads a
 * photographer makes from their own drive (`share_id` null). Viewer dashboards (daily_stats
 * visitors, scanners, scans, downloads, unique downloaders, and share_daily_stats) count `share`
 * events only; `bytes_out` counts both, because it feeds cost estimates and the egress alert.
 */
export const ACTIVITY_SOURCES = ['share', 'owner'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/**
 * Why a share link no longer serves anything (SHARE_EXPIRED details):
 * - `revoked`: the owner revoked it (`is_active = false`), or an admin took it down;
 * - `expired`: `expires_at` has passed;
 * - `unavailable`: the target was trashed or purged, or the owner's subscription is `expired` or
 *   `purged` (the spec's "ลิงก์นี้หมดอายุ").
 */
export const SHARE_UNAVAILABLE_REASONS = ['revoked', 'expired', 'unavailable'] as const;
export type ShareUnavailableReason = (typeof SHARE_UNAVAILABLE_REASONS)[number];

/** Owner-facing state of a share, derived from `is_active` and `expires_at`. */
export const SHARE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];

/** Similarity groups of a face search: "ใช่คุณ" (≥ FACE_STRONG) and "อาจจะเป็นคุณ" (≥ FACE_MAYBE). */
export const FACE_MATCH_BUCKETS = ['strong', 'maybe'] as const;
export type FaceMatchBucket = (typeof FACE_MATCH_BUCKETS)[number];

/** Features behind a flag. The value appears in FEATURE_DISABLED details. */
export const FEATURES = ['face_search'] as const;
export type Feature = (typeof FEATURES)[number];
