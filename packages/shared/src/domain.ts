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

/**
 * Second factor of admin sign-in (ADMIN_MFA_MODE, ADR 0011 decision 4): `off` (default) signs
 * admins in with email + password only; `totp` restores the ADR 0008/0010 TOTP step and enrolment.
 */
export const ADMIN_MFA_MODES = ['off', 'totp'] as const;
export type AdminMfaMode = (typeof ADMIN_MFA_MODES)[number];
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
 * - `paused`: the owner unpublished it for now (`paused_at`, ADR 0016); publishing brings it back;
 * - `expired`: `expires_at` has passed;
 * - `unavailable`: the target was trashed or purged, the owner's account is `disabled` (ADR 0010),
 *   or the owner's subscription is `expired` or `purged` (the spec's "ลิงก์นี้หมดอายุ"; only while
 *   BILLING_MODE=gateway);
 * - `plan_expired` (ADR 0026): the owner's package has run out (`photographer_packages.expires_at`
 *   passed). The share page says the link is closed for now; renewing the package reopens it.
 *   Never for accounts without a package row (unlimited).
 */
export const SHARE_UNAVAILABLE_REASONS = [
  'revoked',
  'paused',
  'expired',
  'unavailable',
  'plan_expired',
] as const;
export type ShareUnavailableReason = (typeof SHARE_UNAVAILABLE_REASONS)[number];

/** Owner-facing state of a share, derived from `is_active`, `paused_at` and `expires_at`. */
export const SHARE_STATUSES = ['active', 'paused', 'expired', 'revoked'] as const;
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
export const CAPTCHA_ACTIONS = ['face_search', 'face_deletion', 'signup_free'] as const;
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
  // ADR 0025: password reset by email. Actor: the account (null for an unknown email).
  /**
   * A reset link was asked for: `meta.outcome` `sent`, `throttled` (over
   * PHOTOGRAPHER_PASSWORD_RESET_EMAILS_PER_HOUR), `no_account` (unknown email, `target_type`
   * `photographer_login`), `disabled`, or `send_failed`. The answer is the same in every case.
   */
  'auth.photographer.password_reset_requested',
  /** The password was set through a reset link (every session of the account revoked). */
  'auth.photographer.password_reset',
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
  /** ADR 0018: an admin opened a photographer's studio (a one-time act-as link). */
  'admin.user.act_as',
  /** ADR 0018: a change an admin made in a photographer's studio (every non-GET request). */
  'admin.act_as.request',
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/** `audit_log.target_type` of ADMIN_AUDIT_ACTIONS. */
export const ADMIN_AUDIT_TARGET_TYPES = {
  user: 'user',
  cashPayment: 'cash_payment',
} as const;

/** `audit_log.action` prefix that may go without an actor. */
export const AUTH_AUDIT_ACTION_PREFIX = 'auth.';

// --- Packages, self sign-up and online payment (ADR 0026) ---------------------------------------

/**
 * Code of the package Free sign-up applies (`packages.code`). It can't be ordered
 * (POST /package-orders answers PACKAGE_UNAVAILABLE) and is taken once per email, only by an email
 * without an account.
 */
export const FREE_PACKAGE_CODE = 'free';

/**
 * `package_orders.status`:
 * - `pending`: created, waiting for the gateway;
 * - `paid`: the gateway confirmed the full amount; the package was applied in the same transaction
 *   (`paid_at`, `applied_at` and `photographer_id` set);
 * - `failed`: the gateway said the payment failed (the buyer may start a new order);
 * - `amount_mismatch`: the gateway reported a paid amount other than `total_satang`; nothing was
 *   applied and the operator looks at it (audit `package.order_amount_mismatch`).
 */
export const PACKAGE_ORDER_STATUSES = ['pending', 'paid', 'failed', 'amount_mismatch'] as const;
export type PackageOrderStatus = (typeof PACKAGE_ORDER_STATUSES)[number];

/**
 * `packages.kind` (ADR 0032, migration 0022):
 * - `plan`: a package of ADR 0026 (days and photos; the home page's cards, Free included);
 * - `days`: an add-on with days only (`photo_limit` 0): more days, photos untouched;
 * - `photos`: an add-on with photos only (`days` 0): more photos, expiry untouched.
 * Add-ons are bought only by signed-in photographers who already have a package.
 */
export const PACKAGE_KINDS = ['plan', 'days', 'photos'] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

/**
 * Package payment gateways: `package_orders.gateway` and the `:gateway` of
 * POST /package-payments/webhooks/:gateway. Separate from PAYMENT_GATEWAYS (the switched-off
 * subscription billing). `fake` is for development and tests only (refused on APP_STAGE=prod).
 */
export const PACKAGE_PAYMENT_GATEWAYS = ['fake', 'mpay'] as const;
export type PackagePaymentGatewayName = (typeof PACKAGE_PAYMENT_GATEWAYS)[number];

/**
 * ADR 0030: `package_orders.gateway` of an order a 100% coupon made free. No gateway is asked:
 * the order is settled when it is created, through the same transaction a paid callback uses.
 */
export const PACKAGE_COUPON_SETTLEMENT = 'coupon';

/**
 * How a buyer pays on Snap's own pay page (ADR 0029): `qr` = a PromptPay QR shown on the page,
 * `card` = the gateway's hosted card form. Gateways with a hosted page of their own offer none.
 */
export const PACKAGE_PAYMENT_METHODS = ['qr', 'card'] as const;
export type PackagePaymentMethod = (typeof PACKAGE_PAYMENT_METHODS)[number];

/** PACKAGE_GATEWAY values: a gateway, or `off` (no online payment; the default). */
export const PACKAGE_GATEWAY_MODES = ['off', ...PACKAGE_PAYMENT_GATEWAYS] as const;
export type PackageGatewayMode = (typeof PACKAGE_GATEWAY_MODES)[number];

/**
 * `audit_log.action` of self sign-up and package orders (ADR 0026), written in the transaction of
 * the change:
 * - `account.self_signup`: Free confirm created a photographer. Actor: the new account;
 *   `target_type` `user`; meta `{ package: 'free' }`.
 * - `package.order_paid`: a paid order was applied. Actor: the order's account (always known once
 *   applied); `target_type` `package_order`; meta `{ orderId, package, totalSatang,
 *   accountCreated }`.
 * - `package.order_amount_mismatch`: the gateway's paid amount differs from `total_satang`;
 *   nothing applied. Actor: the order's photographer, or null when the buyer has no account yet
 *   (the `audit_log_actor_unless_auth_event` CHECK allows `package.` actions without an actor);
 *   `target_type` `package_order`; meta `{ orderId, package, totalSatang, paidSatang }`.
 */
export const PACKAGE_AUDIT_ACTIONS = [
  'account.self_signup',
  'package.order_paid',
  'package.order_amount_mismatch',
] as const;
export type PackageAuditAction = (typeof PACKAGE_AUDIT_ACTIONS)[number];

/** `audit_log.target_type` of PACKAGE_AUDIT_ACTIONS. */
export const PACKAGE_AUDIT_TARGET_TYPES = {
  user: 'user',
  packageOrder: 'package_order',
} as const;

/** `audit_log.action` prefix written by the gateway callback, which may have no actor. */
export const PACKAGE_AUDIT_ACTION_PREFIX = 'package.';

// --- Admin finance and the audit log viewer (ADR 0027) ------------------------------------------

/**
 * `expenses.category` (enum `expense_category`, migration 0017): what a manually recorded expense
 * was for. `payment_fee` is the gateway's fee on package orders; `other` needs no note but should
 * have one.
 */
export const EXPENSE_CATEGORIES = [
  'server',
  'storage',
  'payment_fee',
  'domain',
  'email',
  'marketing',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * `audit_log.action` of the expenses ledger (ADR 0027), written in the transaction of the change,
 * always with the acting admin as `actor_id`; `target_type` `expense`, `target_id` the expense id.
 * Shapes (zod: FINANCE_AUDIT_META_SCHEMAS in api/finance):
 * - `finance.expense_created`: `{ spentOn, amountSatang, category }` (the note is not copied);
 * - `finance.expense_deleted`: `{ spentOn, amountSatang, category }` of the row soft-deleted;
 * - `finance.coupon_created` (ADR 0030, `target_type` `coupon`): `{ code, percentOff,
 *   maxRedemptions, expiresAt }` (the note is not copied);
 * - `finance.coupon_updated` (ADR 0030, `target_type` `coupon`): `{ code, changes }` with only the
 *   fields that changed (`isActive`, `maxRedemptions`, `expiresAt`), each `{ from, to }`.
 */
export const FINANCE_AUDIT_ACTIONS = [
  'finance.expense_created',
  'finance.expense_deleted',
  'finance.coupon_created',
  'finance.coupon_updated',
] as const;
export type FinanceAuditAction = (typeof FINANCE_AUDIT_ACTIONS)[number];

/** `audit_log.target_type` of FINANCE_AUDIT_ACTIONS. */
export const FINANCE_AUDIT_TARGET_TYPES = { expense: 'expense', coupon: 'coupon' } as const;

/**
 * Every `audit_log.action` the system writes today, in display groups (auth, admin, package and
 * self sign-up, finance), so the admin audit-log viewer can label each one (a test checks every
 * action has a Thai label). Add a new action to its group's list above; it appears here by
 * construction. Older rows may hold actions outside this list (e.g. `takedown.share` from tests);
 * the viewer shows those raw.
 */
export const AUDIT_ACTIONS = [
  ...AUTH_AUDIT_ACTIONS,
  ...ADMIN_AUDIT_ACTIONS,
  ...PACKAGE_AUDIT_ACTIONS,
  ...FINANCE_AUDIT_ACTIONS,
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** True when `action` is one of AUDIT_ACTIONS. */
export function isAuditAction(action: string): action is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(action);
}

// --- Print orders (ADR 0031) ---------------------------------------------------------------------

/**
 * `print_orders.status`:
 * - `pending`: a viewer asked; the photographer must allow it first (approval `manual`);
 * - `queued`: allowed (or approval `auto`), waiting for the photographer's print station;
 * - `printed`: a print station (or the photographer's print button) took it and printed it;
 * - `rejected`: the photographer declined it; it no longer counts against the device's limit.
 */
export const PRINT_ORDER_STATUSES = ['pending', 'queued', 'printed', 'rejected'] as const;
export type PrintOrderStatus = (typeof PRINT_ORDER_STATUSES)[number];

/**
 * `print_settings.approval`: `auto` queues every order for printing at once; `manual` holds it
 * as `pending` until the photographer allows it.
 */
export const PRINT_APPROVAL_MODES = ['auto', 'manual'] as const;
export type PrintApprovalMode = (typeof PRINT_APPROVAL_MODES)[number];

/**
 * Paper sizes a photographer can offer, portrait width x height in millimetres (the print page
 * turns the sheet to the photo's orientation). Thai photo shops name the inch sizes 4R, 5R, ...
 */
export const PRINT_PAPER_SIZES = {
  '4r': { widthMm: 102, heightMm: 152 },
  '5r': { widthMm: 127, heightMm: 178 },
  '6r': { widthMm: 152, heightMm: 203 },
  '8r': { widthMm: 203, heightMm: 254 },
  a5: { widthMm: 148, heightMm: 210 },
  a4: { widthMm: 210, heightMm: 297 },
} as const;
export type PrintPaperSize = keyof typeof PRINT_PAPER_SIZES;
export const PRINT_PAPER_SIZE_CODES = Object.keys(PRINT_PAPER_SIZES) as [
  PrintPaperSize,
  ...PrintPaperSize[],
];
