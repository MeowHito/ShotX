// Value sets of the status, role and mode columns in the data model. packages/db builds its
// PostgreSQL enums from these, and API schemas use them, so the two never drift apart.

export const USER_ROLES = ['photographer', 'admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Roles of accounts an admin creates in the admin app (ADR 0010): `admin` (admins pool, password +
 * TOTP) or `photographer` (users pool, email + password). Viewers (`user`) are never created by an
 * admin. An existing account never changes between the two (different pools): create a new one.
 */
export const ACCOUNT_ROLES = ['admin', 'photographer'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/**
 * `users.status` (migration 0011, ADR 0010). `disabled` blocks sign-in (ACCOUNT_DISABLED), revokes
 * every session of the account, and makes a photographer's shares answer SHARE_EXPIRED (reason
 * `unavailable`). Files are never deleted by disabling. `users.disabled_at` is set exactly when
 * the status is `disabled` (users_disabled_at_iff_disabled).
 */
export const ACCOUNT_STATUSES = ['active', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * The pool an identity comes from (`users.auth_pool`): a Cognito user pool (ADR 0002) or the
 * matching pool of ShotX-issued tokens (ADR 0008). `users` holds photographers and viewers,
 * `admins` holds admins only (MFA required). A subject is unique only within its pool.
 */
export const AUTH_POOLS = ['users', 'admins'] as const;
export type AuthPool = (typeof AUTH_POOLS)[number];

/**
 * OpenID Connect providers the API runs itself for the users pool (ADR 0008 section 4; the
 * `:provider` of `/auth/oidc/:provider/start`).
 */
export const OIDC_PROVIDERS = ['line', 'google'] as const;
export type OidcProvider = (typeof OIDC_PROVIDERS)[number];

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
 * link serves (views, scans, downloads, zips; `share_id` set), `owner` for downloads and folder
 * zips a photographer makes from their own drive (`share_id` null). Viewer dashboards (daily_stats
 * visitors, scanners, scans, downloads, unique downloaders, and share_daily_stats) count `share`
 * events only; `bytes_out` counts both, because it feeds cost estimates and the egress alert.
 */
export const ACTIVITY_SOURCES = ['share', 'owner'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/**
 * Why a share link no longer serves anything (SHARE_EXPIRED details):
 * - `revoked`: the owner revoked it (`is_active = false`), or an admin took it down;
 * - `expired`: `expires_at` has passed;
 * - `unavailable`: the target was trashed or purged, the owner's account is `disabled` (ADR 0010),
 *   or the owner's subscription is `expired` or `purged` (the spec's "ลิงก์นี้หมดอายุ"; only while
 *   BILLING_MODE=gateway).
 */
export const SHARE_UNAVAILABLE_REASONS = ['revoked', 'expired', 'unavailable'] as const;
export type ShareUnavailableReason = (typeof SHARE_UNAVAILABLE_REASONS)[number];

/** Owner-facing state of a share, derived from `is_active` and `expires_at`. */
export const SHARE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];

/** Similarity groups of a face search: "ใช่คุณ" (≥ FACE_STRONG) and "อาจจะเป็นคุณ" (≥ FACE_MAYBE). */
export const FACE_MATCH_BUCKETS = ['strong', 'maybe'] as const;
export type FaceMatchBucket = (typeof FACE_MATCH_BUCKETS)[number];

/**
 * What a consent (`consents.purpose`, migration 0004) allows. Each purpose has its own Thai text
 * per policy version, and a consent covers only its own purpose:
 * - `face_search`: scanning a selfie to find the viewer's photos in the share
 *   (`POST /s/:token/face-search`). Needs FACE_SEARCH_ENABLED and an open share.
 * - `face_deletion`: scanning a selfie to delete the person's faces from the share owner's
 *   collection ("ขอลบใบหน้าของฉัน", `POST /s/:token/face-deletion`). A PDPA data-subject right, so
 *   it works with the feature flag off and on revoked or expired shares (see CONSENT_PURPOSE_GATES).
 */
export const CONSENT_PURPOSES = ['face_search', 'face_deletion'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** Features behind a flag. The value appears in FEATURE_DISABLED details. */
export const FEATURES = ['face_search'] as const;
export type Feature = (typeof FEATURES)[number];

// --- Abuse controls (ADR 0008 section 7) ---------------------------------------------------------

/** Turnstile `action` of each route a challenge guards (the widget's `action`, checked server-side). */
export const CAPTCHA_ACTIONS = ['face_search', 'face_deletion'] as const;
export type CaptchaAction = (typeof CAPTCHA_ACTIONS)[number];

/**
 * Why a captcha token didn't unlock a rate-limited request (RateLimitedDetails `captcha.rejected`):
 * - `expired`: older than 300 s or already used (siteverify `timeout-or-duplicate`): solve again;
 * - `invalid`: forged or malformed, or solved for another hostname or action: solve again;
 * - `unavailable`: siteverify failed, timed out or refused the secret: wait and retry. The api
 *   fails closed: no grant without a verified token.
 */
export const CAPTCHA_REJECT_REASONS = ['expired', 'invalid', 'unavailable'] as const;
export type CaptchaRejectReason = (typeof CAPTCHA_REJECT_REASONS)[number];

// --- Billing (Phase 4) ---------------------------------------------------------------------------

/**
 * Payment gateways (`payments.gateway`, `checkout_sessions.gateway`, webhook `:gateway`). `fake`
 * is for development, tests and non-prod stages only (refused when APP_STAGE=prod); `omise` and `2c2p` are
 * placeholders until their adapters exist in the api.
 */
export const PAYMENT_GATEWAYS = ['fake', 'omise', '2c2p'] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];

/**
 * What a checkout does to the subscription. The client declares it and the API checks it against
 * classifyCheckout (else PLAN_CHANGE_INVALID):
 * - `new`: start a paid plan now (from trial, expired or purged, from grace with another plan, or
 *   with no subscription);
 * - `renew`: same plan, more months, appended to `period_end` (active, grace) or from now
 *   (expired);
 * - `upgrade`: a bigger plan, effective at once, prorated charge (active only);
 * - `downgrade`: a smaller plan from `period_end` (active only); never deletes files.
 */
export const CHECKOUT_CHANGE_TYPES = ['new', 'renew', 'upgrade', 'downgrade'] as const;
export type CheckoutChangeType = (typeof CHECKOUT_CHANGE_TYPES)[number];

/**
 * `checkout_sessions.status`: `pending` until its payment is final; `completed` when it was paid
 * and applied, or applied without a payment; `failed` when the payment failed or could not be
 * applied any more (`error_code`); `expired` when nobody paid before `expires_at`.
 */
export const CHECKOUT_STATUSES = ['pending', 'completed', 'failed', 'expired'] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/** Normalized payment webhook event types (parseWebhookEvent). */
export const PAYMENT_EVENT_TYPES = ['paid', 'failed', 'expired', 'refunded'] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

/** Auto-renew intervals a card subscription may use, in months. */
export const AUTO_RENEW_MONTHS = [1, 12] as const;
export type AutoRenewMonths = (typeof AUTO_RENEW_MONTHS)[number];

/**
 * `subscription_events.type`: the audit trail of every subscription change. One row per change,
 * written in the transaction that makes it.
 */
export const SUBSCRIPTION_EVENT_TYPES = [
  /** A subscription row was created (trial onboarding, or `new` after purge / without one). */
  'created',
  /** A `new` checkout moved trial, grace or expired to active with the chosen plan. */
  'activated',
  'renewed',
  'upgraded',
  /** A downgrade was paid or scheduled; it applies at `pending_plan_effective_at`. */
  'downgrade_scheduled',
  /** The daily job applied the pending plan. */
  'downgrade_applied',
  'auto_renew_enabled',
  'auto_renew_canceled',
  /** An auto-renew charge failed (the daily job retries during grace). */
  'renewal_failed',
  'grace_started',
  'expired',
  'purged',
  /** A paid payment could not be applied (the state changed); an admin refunds it. */
  'payment_unapplied',
  /** A payment was refunded at the gateway; the subscription is not changed automatically. */
  'payment_refunded',
] as const;
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];

/** Who caused a subscription event. */
export const BILLING_ACTORS = ['photographer', 'gateway', 'system', 'admin'] as const;
export type BillingActor = (typeof BILLING_ACTORS)[number];

/**
 * Lifecycle emails logged in `subscription_notices` (unique per subscription, kind, period end and
 * day), so the daily job sends each at most once. Receipts are logged on the payment instead
 * (`payments.receipt_sent_at`).
 */
export const SUBSCRIPTION_NOTICE_KINDS = [
  'renewal_reminder',
  'grace_started',
  'expired',
  'purge_warning',
] as const;
export type SubscriptionNoticeKind = (typeof SUBSCRIPTION_NOTICE_KINDS)[number];

/**
 * Why a checkout is refused with PLAN_CHANGE_INVALID (details.reason):
 * - `change_type_mismatch`: the declared changeType isn't classifyCheckout's (details.expected);
 * - `pending_change_exists`: a downgrade is scheduled; no other change until it applies;
 * - `auto_renew_active`: card renew while auto-renew is on (it renews by itself);
 * - `card_downgrade_needs_auto_renew`: a card downgrade only reschedules an auto-renew
 *   subscription; prepaid subscriptions downgrade with PromptPay;
 * - `months_required` / `months_not_allowed`: PromptPay months must be given for new, renew and
 *   downgrade, and must be absent for upgrade (it charges proration only);
 * - `months_not_offered`: months not in BILLING_PREPAID_MONTHS.
 */
export const PLAN_CHANGE_INVALID_REASONS = [
  'change_type_mismatch',
  'pending_change_exists',
  'auto_renew_active',
  'card_downgrade_needs_auto_renew',
  'months_required',
  'months_not_allowed',
  'months_not_offered',
] as const;
export type PlanChangeInvalidReason = (typeof PLAN_CHANGE_INVALID_REASONS)[number];

// --- Auth (ADR 0008) -----------------------------------------------------------------------------

/**
 * `audit_log.action` of sign-in and admin-account events. These rows may have no actor
 * (`actor_id` null, migration 0005: the CHECK allows it for every `auth.` action): a failed
 * sign-in whose email matches no admin, and the operator CLI's actions (`created`, `totp_reset`,
 * `password_reset`, `unlocked`), which no signed-in user performs. Every other action needs an
 * actor. `target_type` is `user` with the user id when the account is known, else `admin_login`
 * with an HMAC of the normalized email (IP_HASH_SECRET), never the email itself. `meta` holds the
 * reason and the IP hash (CLI actions: the operator's OS user, if known).
 */
export const AUTH_AUDIT_ACTIONS = [
  'auth.admin.sign_in',
  'auth.admin.sign_in_failed',
  'auth.admin.mfa_failed',
  'auth.admin.locked',
  'auth.admin.totp_confirmed',
  'auth.admin.created',
  'auth.admin.totp_reset',
  'auth.admin.password_reset',
  'auth.admin.unlocked',
  'auth.refresh_reused',
  // ADR 0010 (migration 0011). Actor: the signed-in account itself (null for an unknown email).
  /** A UI-created admin set their own password in the sign-in step (POST /auth/admin/password). */
  'auth.admin.password_changed',
  /** A sign-in generated a TOTP secret and showed it to the admin (UI-created admins). */
  'auth.admin.totp_enrolment_started',
  /** Photographer email + password sign-in (POST /auth/photographer/sign-in). */
  'auth.photographer.sign_in',
  /** Wrong password or unknown email; `target_type` `photographer_login` with the email HMAC. */
  'auth.photographer.sign_in_failed',
  'auth.photographer.locked',
  /** Correct password on a disabled account (ACCOUNT_DISABLED). */
  'auth.photographer.sign_in_disabled',
  /** POST /auth/photographer/password (forced first change or a voluntary one). */
  'auth.photographer.password_changed',
] as const;
export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[number];

/**
 * `audit_log.action` of admin user management (ADR 0010), written in the same transaction as the
 * change, always with the acting admin as `actor_id`. Named like AUTH_AUDIT_ACTIONS
 * (`<area>.<object>.<past tense>`). `target_type` is ADMIN_AUDIT_TARGET_TYPES' value, `target_id`
 * the row id. `meta` never holds a password, a hash or a TOTP secret. Shapes (zod:
 * ADMIN_AUDIT_META_SCHEMAS in api/admin):
 * - `admin.user.created`: `{ role, email }`;
 * - `admin.user.updated`: `{ changed: ['name'], oldName, newName }` (a status change writes
 *   `admin.user.disabled` / `admin.user.enabled` instead; `changed` may list `status` too when one
 *   PATCH did both, and the names are present whenever `name` is in `changed`);
 * - `admin.user.disabled`: `{ revokedSessions }` (families revoked); `admin.user.enabled`: `{}`;
 * - `admin.user.password_reset`: `{}` (the account must change it at next sign-in);
 * - `admin.cash_payment.created`: `{ photographerId, amountSatang, paidAt }` (paidAt ISO).
 */
export const ADMIN_AUDIT_ACTIONS = [
  'admin.user.created',
  'admin.user.updated',
  'admin.user.disabled',
  'admin.user.enabled',
  'admin.user.password_reset',
  'admin.cash_payment.created',
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/** `audit_log.target_type` of ADMIN_AUDIT_ACTIONS. */
export const ADMIN_AUDIT_TARGET_TYPES = {
  user: 'user',
  cashPayment: 'cash_payment',
} as const;

/** `audit_log.action` prefix that may go without an actor. */
export const AUTH_AUDIT_ACTION_PREFIX = 'auth.';
