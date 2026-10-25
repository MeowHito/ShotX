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
