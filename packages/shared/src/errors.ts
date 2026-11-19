import { z } from 'zod';
import { PASSWORD_POLICY_REASONS } from './account/password-accounts';
import { DESIGN_DOC_LIMIT_REASONS } from './design/doc';
import {
  CAPTCHA_ACTIONS,
  CAPTCHA_REJECT_REASONS,
  CHECKOUT_CHANGE_TYPES,
  FEATURES,
  OIDC_PROVIDERS,
  PLAN_CHANGE_INVALID_REASONS,
  SHARE_UNAVAILABLE_REASONS,
  SUBSCRIPTION_STATUSES,
} from './domain';

/** Stable API error codes. The web app maps each code to a Thai message. */
export const ErrorCode = {
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  SHARE_EXPIRED: 'SHARE_EXPIRED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  NO_FACE_DETECTED: 'NO_FACE_DETECTED',
  /**
   * Too many requests. On face search and face deletion: details RateLimitedDetails (whether a
   * Turnstile challenge can unlock more attempts, and why a sent token was refused).
   */
  RATE_LIMITED: 'RATE_LIMITED',
  /** The request body is over its limit (413). The WAF returns it for face search too. */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** The extension or declared MIME type is not on the upload allowlist, or bytes don't match. */
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  /** The file is over the per-file size limit for its media kind. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',

  // Generic codes (Phase 2).
  /** The request params, query or body failed schema validation. Details: ValidationFailedDetails. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /**
   * No valid token, or the token is from the wrong pool for this route. On `bff` routes: the
   * BFF key is missing or wrong.
   */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Authenticated, but the role may not use this route (e.g. a viewer calling /drive). */
  FORBIDDEN: 'FORBIDDEN',
  /**
   * The resource doesn't exist, is trashed where a live one is required, or belongs to someone
   * else. Another owner's items are always NOT_FOUND, never FORBIDDEN, so ids leak nothing.
   */
  NOT_FOUND: 'NOT_FOUND',
  /** The request conflicts with the resource's current state (e.g. aborting a completed upload). */
  CONFLICT: 'CONFLICT',
  /** Unexpected server error. The message is generic; details are never sent. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Drive (Phase 2).
  /**
   * A live sibling already has this name, ignoring ASCII case (see driveNameKey). Folders and
   * files are separate namespaces. Details: NameTakenDetails.
   */
  NAME_TAKEN: 'NAME_TAKEN',
  /** A folder can't be moved into itself or one of its descendants. */
  INVALID_MOVE: 'INVALID_MOVE',
  /** The folder tree would be deeper than DRIVE_MAX_FOLDER_DEPTH. Details: FolderDepthExceededDetails. */
  FOLDER_DEPTH_EXCEEDED: 'FOLDER_DEPTH_EXCEEDED',
  /** Uploads are blocked: no subscription, or it is grace, expired or purged. */
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',

  // Uploads (Phase 2).
  /** No pending upload with this id for the caller (never started, aborted, or purged). */
  UPLOAD_NOT_FOUND: 'UPLOAD_NOT_FOUND',
  /** The upload session passed its expiresAt; start again with POST /uploads/init. */
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
  /**
   * The parts sent to complete don't match what S3 has, or the uploaded sizes don't add up to
   * the declared size.
   */
  UPLOAD_PARTS_INVALID: 'UPLOAD_PARTS_INVALID',

  // Idempotency (Phase 3).
  /**
   * The idempotency key (`Idempotency-Key` header, or `clientUploadId` of upload init) was used
   * before with a different request, or by another viewer. Details: none.
   */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // Sharing, face search and downloads (Phase 3). Unknown share tokens are NOT_FOUND.
  /** The share requires a signed-in viewer (`require_login`) and the request has none. */
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  /** The share has a password and this browser hasn't unlocked it (POST /s/:token/unlock). */
  PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
  /**
   * POST /s/:token/unlock with the wrong password; also POST /auth/photographer/password with the
   * wrong `currentPassword` (ADR 0010; counts as a failed attempt towards the lockout).
   */
  PASSWORD_INCORRECT: 'PASSWORD_INCORRECT',
  /**
   * The consent was given for another policy version than the current one (the page showed an
   * old text). Reload the share meta and show the current text. Details: ConsentVersionDetails.
   */
  CONSENT_VERSION_MISMATCH: 'CONSENT_VERSION_MISMATCH',
  /** The share doesn't allow downloads (`allow_download = false`). */
  DOWNLOAD_NOT_ALLOWED: 'DOWNLOAD_NOT_ALLOWED',
  /** A zip request over ZIP_MAX_FILES or ZIP_MAX_BYTES. Details: ZipTooLargeDetails. */
  ZIP_TOO_LARGE: 'ZIP_TOO_LARGE',
  /**
   * The feature is switched off by configuration (FACE_SEARCH_ENABLED=false): face-search consent,
   * face search, feedback, enabling face indexing and face_only shares. Never for face deletion,
   * its consent or consent withdrawal (PDPA rights work with the flag off). Details:
   * FeatureDisabledDetails.
   */
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  /**
   * Face search is on, but not for this share: it isn't a folder share, or no folder in it has an
   * active face index. Details: FaceSearchUnavailableDetails.
   */
  FACE_SEARCH_UNAVAILABLE: 'FACE_SEARCH_UNAVAILABLE',

  // Billing (Phase 4). Uploads blocked for an unpaid account stay SUBSCRIPTION_INACTIVE (there is
  // no PAYMENT_REQUIRED code).
  /** The plan code is unknown, inactive, or the trial (which can't be bought). */
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  /**
   * The checkout doesn't fit the subscription's state (wrong changeType, a pending downgrade, card
   * renew while auto-renew is on, ...). Details: PlanChangeInvalidDetails.
   */
  PLAN_CHANGE_INVALID: 'PLAN_CHANGE_INVALID',
  /**
   * Another checkout of this photographer is still waiting for payment (one at a time). Details:
   * CheckoutPendingDetails (poll that payment, or wait until it expires).
   */
  CHECKOUT_PENDING: 'CHECKOUT_PENDING',
  /** The Idempotency-Key belongs to a checkout that expired unpaid: start again with a new key. */
  CHECKOUT_EXPIRED: 'CHECKOUT_EXPIRED',
  /** A payment webhook whose signature is missing, malformed, wrong or stale. Nothing is stored. */
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  /** The payment gateway failed or timed out (creating a checkout, cancelling auto-renew). */
  PAYMENT_GATEWAY_ERROR: 'PAYMENT_GATEWAY_ERROR',

  // Sign-in issued by the API (ADR 0008 section 4, AUTH_ROUTES). Never says whether an account
  // exists.
  /**
   * The identity provider is not enabled here: LINE or Google without both its id and secret, on
   * any stage (POST /auth/oidc/:provider/start). Details: AuthProviderUnavailableDetails.
   */
  AUTH_PROVIDER_UNAVAILABLE: 'AUTH_PROVIDER_UNAVAILABLE',
  /**
   * The login state is unknown, expired or already used: the OIDC `state` of a callback, or the
   * `challengeId` of an admin sign-in step (password change, MFA or TOTP enrolment), or a
   * challenge used for another step than the one it was issued for. Start the sign-in again.
   */
  LOGIN_STATE_INVALID: 'LOGIN_STATE_INVALID',
  /**
   * LINE or Google failed: the code exchange was refused or timed out, or the ID token failed
   * verification (issuer, audience, nonce, expiry, signature). Details: IdentityProviderErrorDetails.
   */
  IDENTITY_PROVIDER_ERROR: 'IDENTITY_PROVIDER_ERROR',
  /**
   * Admin or photographer sign-in: wrong email or password, no such account, or no password
   * credentials. One code for all of them, so the response never reveals whether an account
   * exists. A locked account (too many failures) is RATE_LIMITED, with `Retry-After`.
   */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /**
   * Admin MFA step: the TOTP code is wrong, outside the window, or was already used; also the
   * code that should confirm a new TOTP enrolment.
   */
  MFA_INVALID: 'MFA_INVALID',
  /**
   * An admins-pool token without the methods ADMIN_MFA_MODE requires in its `amr` claim
   * (adminRequiredAmr: `pwd` with `off`, the default since ADR 0011; `pwd` and `otp` with `totp`).
   * Every admin route answers this instead of serving the request; with `off` it only happens to
   * tokens without `pwd`, which the api never issues to admins.
   */
  MFA_REQUIRED: 'MFA_REQUIRED',
  /** The refresh token is unknown, expired, revoked, or of another pool than the request named. */
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  /**
   * The refresh token was already rotated: it may have been stolen, so its whole session family
   * is revoked. Sign in again.
   */
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',

  // Admin-provisioned accounts (ADR 0010).
  /**
   * The signed-in photographer's password is temporary (set by an admin at create or reset): the
   * session carries PASSWORD_CHANGE_CLAIM and may only call PASSWORD_CHANGE_ALLOWED_ROUTES until
   * POST /auth/photographer/password succeeds. The web app shows the change-password form.
   */
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /**
   * The account is disabled (`users.status`). Password sign-ins answer it only after the password
   * was verified (so it reveals nothing to someone without the password); LINE/Google sign-in
   * (OIDC callback) and the dev login answer it for a disabled account once the identity is
   * verified; routes answer it for a token issued before the account was disabled (disabling
   * also revokes every session).
   */
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  /**
   * Another email + password account (admin or photographer, either pool) already has this email,
   * ignoring ASCII case (`users_password_account_email_unique`, normalizeAccountEmail).
   */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /**
   * The change would leave no active admin: disabling another admin who is the last other active
   * admin. Self-disable is CANNOT_MODIFY_SELF (checked first), so in practice this is a race (two
   * admins disabling each other at once); the api counts inside the transaction.
   */
  LAST_ADMIN: 'LAST_ADMIN',
  /**
   * An admin may not disable or reset the password of their own account in the admin users
   * routes (renaming themself is allowed). Checked before LAST_ADMIN.
   */
  CANNOT_MODIFY_SELF: 'CANNOT_MODIFY_SELF',
  /** A new password breaks the policy. Details: PasswordTooWeakDetails. */
  PASSWORD_TOO_WEAK: 'PASSWORD_TOO_WEAK',

  // Viewer sign-in switched off (2026-11-11 launch without LINE/Google).
  /**
   * POST /shares or PATCH /shares/:id with `requireLogin: true` while no viewer can sign in (no
   * LINE or Google configured and no dev login; viewerLoginAvailable is false). Nothing is
   * changed. Not sent with AUTH_PROVIDER=cognito, for `requireLogin: false`, or for a PATCH that
   * leaves `requireLogin` out (an existing `require_login` share stays editable). Details: none.
   */
  LOGIN_PROVIDER_UNAVAILABLE: 'LOGIN_PROVIDER_UNAVAILABLE',

  // Event gallery redesign (ADR 0011).
  /**
   * PATCH /drive/folders/:id with a `coverFileId` of the caller's that can't be the folder's cover:
   * not live, not `ready`, not an image, or outside the folder's subtree. Nothing is changed. An
   * unknown or another owner's file id is NOT_FOUND. Details: CoverFileInvalidDetails.
   */
  COVER_FILE_INVALID: 'COVER_FILE_INVALID',

  // Share page designer (ADR 0013). Unknown or other owners' designs and design images in the
  // /designs routes themselves are NOT_FOUND, as everywhere.
  /**
   * `PUT /designs/:id` with a `revision` other than the design's current one: someone (another
   * tab, an earlier autosave) saved since the editor loaded it. Nothing is changed; the editor
   * offers to reload. Details: DesignRevisionConflictDetails.
   */
  DESIGN_REVISION_CONFLICT: 'DESIGN_REVISION_CONFLICT',
  /**
   * A document sent to `POST /designs` or `PUT /designs/:id` references design images that are
   * not the caller's (unknown, another owner's, or purged). Images still uploading or processing
   * are allowed. Nothing is changed. Details: DesignAssetNotFoundDetails.
   */
  DESIGN_ASSET_NOT_FOUND: 'DESIGN_ASSET_NOT_FOUND',
  /**
   * `POST /designs` when the caller already has DESIGN_MAX_PER_OWNER designs. Details:
   * DesignLimitReachedDetails.
   */
  DESIGN_LIMIT_REACHED: 'DESIGN_LIMIT_REACHED',
  /**
   * A document over the configured DESIGN_MAX_ELEMENTS or DESIGN_DOC_MAX_BYTES
   * (checkDesignDocLimits); documents over the hard ceilings fail validation instead. Nothing is
   * changed. Details: DesignDocTooLargeDetails.
   */
  DESIGN_DOC_TOO_LARGE: 'DESIGN_DOC_TOO_LARGE',
  /**
   * `POST /shares` or `PATCH /shares/:id` with a `designId` that is not one of the caller's
   * designs (unknown, another owner's, or deleted). Nothing is changed. Details: none.
   */
  DESIGN_NOT_FOUND: 'DESIGN_NOT_FOUND',

  // Photographer password reset by email (ADR 0025).
  /**
   * POST /auth/photographer/password-reset/confirm with a link token that is unknown, expired,
   * already used, or no longer valid because the account's password changed (or was reset by an
   * admin) or the account was disabled after the email was sent. Ask for a new link.
   */
  PASSWORD_RESET_INVALID: 'PASSWORD_RESET_INVALID',

  // Packages, self sign-up and online payment (ADR 0026). Accounts without a package row are
  // unlimited and never get PLAN_EXPIRED or PHOTO_LIMIT_REACHED.
  /**
   * The photographer's package has expired (`now >= photographer_packages.expires_at`):
   * POST /uploads/init, creating a share, re-activating or un-pausing one, and turning on face
   * indexing are refused. Browsing, renaming, deleting and the owner's own downloads keep working.
   * Shares of the account answer SHARE_EXPIRED with reason `plan_expired` instead. Details:
   * PlanExpiredDetails.
   */
  PLAN_EXPIRED: 'PLAN_EXPIRED',
  /**
   * POST /uploads/init would take the package past its photo limit
   * (`photos_used + 1 > photo_limit`). Nothing is created. Details: PhotoLimitReachedDetails.
   */
  PHOTO_LIMIT_REACHED: 'PHOTO_LIMIT_REACHED',
  /**
   * POST /package-orders with a package code that is unknown, inactive, free (FREE_PACKAGE_CODE) or
   * priced 0: it can't be bought online.
   */
  PACKAGE_UNAVAILABLE: 'PACKAGE_UNAVAILABLE',
  /**
   * POST /package-orders while PACKAGE_GATEWAY=off: online payment isn't open yet. The dialog says
   * it opens soon and to contact the team. Not a 5xx: it is off on purpose.
   */
  PAYMENT_UNAVAILABLE: 'PAYMENT_UNAVAILABLE',
  /**
   * POST /package-orders with an email that can't buy a package online: it belongs to an admin, a
   * disabled account, or an unlimited (admin-created, no package row) photographer. One generic
   * code and message for all of them.
   */
  EMAIL_UNAVAILABLE: 'EMAIL_UNAVAILABLE',
  /**
   * POST /signup/free/confirm with a link token that is unknown, expired or already used, or the
   * email got an account since the link was sent. Ask for a new link (or sign in).
   */
  SIGNUP_LINK_INVALID: 'SIGNUP_LINK_INVALID',
  /**
   * GET /package-orders/:id (and its fake-result) with an unknown order id or a wrong
   * X-Order-Token. One code for both, so the answer never confirms that an order id exists.
   */
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  /**
   * ADR 0030: a coupon code that is unknown, switched off or past its expiry. One code for all of
   * them, so the answer never says which codes exist.
   */
  COUPON_INVALID: 'COUPON_INVALID',
  /** ADR 0030: the coupon's uses (paid orders plus orders still holding one) are all taken. */
  COUPON_USED_UP: 'COUPON_USED_UP',
  /**
   * ADR 0031: the share's photographer has print orders switched off (or the file is a video).
   * Not 503: the feature is off on purpose.
   */
  PRINT_UNAVAILABLE: 'PRINT_UNAVAILABLE',
  /**
   * ADR 0031: this device (the anon_id cookie) has used all the prints the photographer allows
   * per device on this share. Details: PrintLimitReachedDetails.
   */
  PRINT_LIMIT_REACHED: 'PRINT_LIMIT_REACHED',
  /** ADR 0031: the paper size is not one the photographer offers. */
  PRINT_SIZE_UNAVAILABLE: 'PRINT_SIZE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES = Object.values(ErrorCode) as readonly ErrorCode[];

/** HTTP status the API sends with each code. Adding a code without a status fails typecheck. */
export const ERROR_HTTP_STATUS = {
  QUOTA_EXCEEDED: 403,
  SHARE_EXPIRED: 410,
  CONSENT_REQUIRED: 403,
  NO_FACE_DETECTED: 422,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  NAME_TAKEN: 409,
  INVALID_MOVE: 409,
  FOLDER_DEPTH_EXCEEDED: 422,
  SUBSCRIPTION_INACTIVE: 403,
  UPLOAD_NOT_FOUND: 404,
  UPLOAD_EXPIRED: 410,
  UPLOAD_PARTS_INVALID: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  LOGIN_REQUIRED: 401,
  PASSWORD_REQUIRED: 403,
  PASSWORD_INCORRECT: 403,
  CONSENT_VERSION_MISMATCH: 409,
  DOWNLOAD_NOT_ALLOWED: 403,
  ZIP_TOO_LARGE: 422,
  // Not 503: the feature is off on purpose, not an outage. 5xx would page on-call and make
  // clients retry.
  FEATURE_DISABLED: 404,
  FACE_SEARCH_UNAVAILABLE: 409,
  PLAN_NOT_FOUND: 404,
  PLAN_CHANGE_INVALID: 409,
  CHECKOUT_PENDING: 409,
  CHECKOUT_EXPIRED: 410,
  WEBHOOK_SIGNATURE_INVALID: 401,
  PAYMENT_GATEWAY_ERROR: 502,
  AUTH_PROVIDER_UNAVAILABLE: 404,
  LOGIN_STATE_INVALID: 400,
  PASSWORD_RESET_INVALID: 400,
  IDENTITY_PROVIDER_ERROR: 502,
  INVALID_CREDENTIALS: 401,
  MFA_INVALID: 401,
  MFA_REQUIRED: 401,
  REFRESH_TOKEN_INVALID: 401,
  REFRESH_TOKEN_REUSED: 401,
  PASSWORD_CHANGE_REQUIRED: 403,
  ACCOUNT_DISABLED: 403,
  EMAIL_TAKEN: 409,
  LAST_ADMIN: 409,
  CANNOT_MODIFY_SELF: 403,
  PASSWORD_TOO_WEAK: 422,
  LOGIN_PROVIDER_UNAVAILABLE: 409,
  COVER_FILE_INVALID: 422,
  DESIGN_REVISION_CONFLICT: 409,
  DESIGN_ASSET_NOT_FOUND: 422,
  DESIGN_LIMIT_REACHED: 409,
  DESIGN_DOC_TOO_LARGE: 422,
  DESIGN_NOT_FOUND: 422,
  PLAN_EXPIRED: 403,
  PHOTO_LIMIT_REACHED: 403,
  PACKAGE_UNAVAILABLE: 404,
  // Not 503: payment is off on purpose (PACKAGE_GATEWAY=off), not an outage.
  PAYMENT_UNAVAILABLE: 409,
  EMAIL_UNAVAILABLE: 409,
  SIGNUP_LINK_INVALID: 400,
  ORDER_NOT_FOUND: 404,
  COUPON_INVALID: 422,
  COUPON_USED_UP: 409,
  PRINT_UNAVAILABLE: 404,
  PRINT_LIMIT_REACHED: 409,
  PRINT_SIZE_UNAVAILABLE: 422,
} as const satisfies Record<ErrorCode, number>;

/** Body of every API error response. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * zod schema of {@link ApiErrorBody}. `message` is English for logs and developers; users see the
 * Thai text the web app maps from `code`.
 */
export const apiErrorBodySchema = z.object({
  code: z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]),
  message: z.string(),
  details: z.unknown().optional(),
});

// Typed `details` of the codes that carry them. Every other code sends no details.

export const validationFailedDetailsSchema = z.object({
  /** Where validation failed, e.g. `['body', 'items', 0, 'id']`, and why. Values are never echoed. */
  issues: z.array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string(),
    }),
  ),
});
export type ValidationFailedDetails = z.output<typeof validationFailedDetailsSchema>;

export const quotaExceededDetailsSchema = z.object({
  quotaBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  requestedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
});
export type QuotaExceededDetails = z.output<typeof quotaExceededDetailsSchema>;

export const fileTooLargeDetailsSchema = z.object({ maxBytes: z.number().int().positive() });
export type FileTooLargeDetails = z.output<typeof fileTooLargeDetailsSchema>;

/**
 * Why a file type was rejected, so the web app can say "convert HEIC to JPEG on the phone" or
 * "RAW files aren't supported" instead of a generic message.
 */
export const REJECTED_FILE_TYPE_HINTS = ['heic', 'raw'] as const;
export type RejectedFileTypeHint = (typeof REJECTED_FILE_TYPE_HINTS)[number];

export const unsupportedFileTypeDetailsSchema = z.object({
  /** Lowercase extension without the dot, or null when the name has none. */
  extension: z.string().nullable(),
  hint: z.enum(REJECTED_FILE_TYPE_HINTS).nullable(),
});
export type UnsupportedFileTypeDetails = z.output<typeof unsupportedFileTypeDetailsSchema>;

export const nameTakenDetailsSchema = z.object({
  kind: z.enum(['folder', 'file']),
  /** The requested name (after normalization). */
  name: z.string(),
});
export type NameTakenDetails = z.output<typeof nameTakenDetailsSchema>;

export const folderDepthExceededDetailsSchema = z.object({
  maxDepth: z.number().int().positive(),
});
export type FolderDepthExceededDetails = z.output<typeof folderDepthExceededDetailsSchema>;

export const subscriptionInactiveDetailsSchema = z.object({
  /** The photographer's latest subscription status, or null when they never had one. */
  status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
});
export type SubscriptionInactiveDetails = z.output<typeof subscriptionInactiveDetailsSchema>;

export const shareExpiredDetailsSchema = z.object({ reason: z.enum(SHARE_UNAVAILABLE_REASONS) });
export type ShareExpiredDetails = z.output<typeof shareExpiredDetailsSchema>;

/** CONSENT_REQUIRED and CONSENT_VERSION_MISMATCH: the version whose text the page must show. */
export const consentVersionDetailsSchema = z.object({ policyVersion: z.string().min(1) });
export type ConsentVersionDetails = z.output<typeof consentVersionDetailsSchema>;

export const noFaceDetectedDetailsSchema = z.object({
  /** Selfies in the request, and how many of them had no detectable face (all of them). */
  selfies: z.number().int().positive(),
  selfiesWithoutFace: z.number().int().nonnegative(),
});
export type NoFaceDetectedDetails = z.output<typeof noFaceDetectedDetailsSchema>;

export const zipTooLargeDetailsSchema = z.object({
  maxFiles: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  /** What the request asked for (files in the share's scope and grant only). */
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type ZipTooLargeDetails = z.output<typeof zipTooLargeDetailsSchema>;

/**
 * RATE_LIMITED on face search and face deletion (POST /s/:token/face-search and
 * /s/:token/face-deletion); other routes send no details. `Retry-After` carries the same seconds.
 * See config/captcha.ts for the whole flow.
 */
export const rateLimitedDetailsSchema = z.object({
  /** Seconds until the limit that was hit lets requests through again. */
  retryAfterSeconds: z.number().int().nonnegative(),
  /**
   * Set when solving a challenge unlocks more attempts now (CAPTCHA_PROVIDER=turnstile and the
   * client IP has grants left): show the widget with `action` and repeat the request with the
   * token in CAPTCHA_TOKEN_HEADER. Null when only waiting helps.
   */
  captcha: z
    .object({
      provider: z.literal('turnstile'),
      action: z.enum(CAPTCHA_ACTIONS),
      /** Why the token sent with this request was not accepted; null when none was sent. */
      rejected: z.enum(CAPTCHA_REJECT_REASONS).nullable(),
    })
    .nullable(),
});
export type RateLimitedDetails = z.output<typeof rateLimitedDetailsSchema>;

export const featureDisabledDetailsSchema = z.object({ feature: z.enum(FEATURES) });
export type FeatureDisabledDetails = z.output<typeof featureDisabledDetailsSchema>;

/**
 * - `not_folder_share`: face search works on folder shares only;
 * - `not_indexed`: no folder at or below the share's root (or above it) has an active face index
 *   (`face_index_enabled` and `face_index_expires_at` in the future).
 */
export const FACE_SEARCH_UNAVAILABLE_REASONS = ['not_folder_share', 'not_indexed'] as const;
export type FaceSearchUnavailableReason = (typeof FACE_SEARCH_UNAVAILABLE_REASONS)[number];

export const faceSearchUnavailableDetailsSchema = z.object({
  reason: z.enum(FACE_SEARCH_UNAVAILABLE_REASONS),
});
export type FaceSearchUnavailableDetails = z.output<typeof faceSearchUnavailableDetailsSchema>;

export const planChangeInvalidDetailsSchema = z.object({
  reason: z.enum(PLAN_CHANGE_INVALID_REASONS),
  /** The changeType this plan would be right now (classifyCheckout). */
  expectedChangeType: z.enum(CHECKOUT_CHANGE_TYPES),
});
export type PlanChangeInvalidDetails = z.output<typeof planChangeInvalidDetailsSchema>;

export const checkoutPendingDetailsSchema = z.object({
  /** The pending checkout's payment (null while it has none yet: retry in a few seconds). */
  paymentId: z.uuid().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type CheckoutPendingDetails = z.output<typeof checkoutPendingDetailsSchema>;

export const authProviderUnavailableDetailsSchema = z.object({
  provider: z.enum(OIDC_PROVIDERS),
});
export type AuthProviderUnavailableDetails = z.output<typeof authProviderUnavailableDetailsSchema>;

/**
 * - `exchange_failed`: the token endpoint refused the code (expired, reused, wrong redirect URI);
 * - `id_token_invalid`: the ID token failed verification;
 * - `unavailable`: the provider timed out or answered 5xx.
 */
export const IDENTITY_PROVIDER_ERROR_REASONS = [
  'exchange_failed',
  'id_token_invalid',
  'unavailable',
] as const;
export type IdentityProviderErrorReason = (typeof IDENTITY_PROVIDER_ERROR_REASONS)[number];

export const identityProviderErrorDetailsSchema = z.object({
  provider: z.enum(OIDC_PROVIDERS),
  reason: z.enum(IDENTITY_PROVIDER_ERROR_REASONS),
});
export type IdentityProviderErrorDetails = z.output<typeof identityProviderErrorDetailsSchema>;

/**
 * PASSWORD_TOO_WEAK: the first rule the password breaks (PASSWORD_POLICY_REASONS) and the pool's
 * minimum length, so the form can say "อย่างน้อย N ตัวอักษร".
 */
export const passwordTooWeakDetailsSchema = z.object({
  reason: z.enum(PASSWORD_POLICY_REASONS),
  minLength: z.number().int().positive(),
});
export type PasswordTooWeakDetails = z.output<typeof passwordTooWeakDetailsSchema>;

/**
 * Informational codes in successful billing responses (`notices`), never sent as errors. The web
 * app maps them to Thai text like error codes.
 * - `DOWNGRADE_EXCEEDS_QUOTA`: the smaller plan is below what is stored; uploads will be blocked
 *   from the effective date until it fits. Nothing is deleted. Details: downgradeQuotaNotice.
 */
export const BILLING_NOTICE_CODES = ['DOWNGRADE_EXCEEDS_QUOTA'] as const;
export type BillingNoticeCode = (typeof BILLING_NOTICE_CODES)[number];

export const downgradeExceedsQuotaDetailsSchema = z.object({
  quotaBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  overBytes: z.number().int().positive(),
});

export const billingNoticeSchema = z.object({
  code: z.literal('DOWNGRADE_EXCEEDS_QUOTA'),
  details: downgradeExceedsQuotaDetailsSchema,
});
export type BillingNotice = z.output<typeof billingNoticeSchema>;

/** Why a file can't be a folder's cover (COVER_FILE_INVALID). */
export const COVER_FILE_INVALID_REASONS = [
  /** Trashed or being purged. */
  'not_live',
  /** Still uploading or processing, or failed. */
  'not_ready',
  /** A video: covers are images (preview.webp). */
  'not_image',
  /** Not inside the folder's subtree. */
  'outside_folder',
] as const;
export type CoverFileInvalidReason = (typeof COVER_FILE_INVALID_REASONS)[number];

export const coverFileInvalidDetailsSchema = z.object({
  reason: z.enum(COVER_FILE_INVALID_REASONS),
});
export type CoverFileInvalidDetails = z.output<typeof coverFileInvalidDetailsSchema>;

/** DESIGN_REVISION_CONFLICT: the design's revision now (reload to get its document). */
export const designRevisionConflictDetailsSchema = z.object({
  currentRevision: z.number().int().positive(),
});
export type DesignRevisionConflictDetails = z.output<typeof designRevisionConflictDetailsSchema>;

/** DESIGN_ASSET_NOT_FOUND: every referenced id that is not the caller's, in document order. */
export const designAssetNotFoundDetailsSchema = z.object({
  assetIds: z.array(z.uuid()).min(1),
});
export type DesignAssetNotFoundDetails = z.output<typeof designAssetNotFoundDetailsSchema>;

/** DESIGN_LIMIT_REACHED: DESIGN_MAX_PER_OWNER. */
export const designLimitReachedDetailsSchema = z.object({
  maxDesigns: z.number().int().positive(),
});
export type DesignLimitReachedDetails = z.output<typeof designLimitReachedDetailsSchema>;

/**
 * DESIGN_DOC_TOO_LARGE: the first configured limit broken (checkDesignDocLimits): `elements`
 * (count vs DESIGN_MAX_ELEMENTS) or `bytes` (JSON UTF-8 bytes vs DESIGN_DOC_MAX_BYTES).
 */
export const designDocTooLargeDetailsSchema = z.object({
  reason: z.enum(DESIGN_DOC_LIMIT_REASONS),
  max: z.number().int().positive(),
  actual: z.number().int().positive(),
});
export type DesignDocTooLargeDetails = z.output<typeof designDocTooLargeDetailsSchema>;

/** PLAN_EXPIRED: when the package ran out. */
export const planExpiredDetailsSchema = z.object({
  expiresAt: z.iso.datetime({ offset: true }),
});
export type PlanExpiredDetails = z.output<typeof planExpiredDetailsSchema>;

/** PHOTO_LIMIT_REACHED: the package's limit, what is used, and what the request asked for. */
export const photoLimitReachedDetailsSchema = z.object({
  photoLimit: z.number().int().positive(),
  photosUsed: z.number().int().nonnegative(),
  requested: z.number().int().positive(),
});
export type PhotoLimitReachedDetails = z.output<typeof photoLimitReachedDetailsSchema>;

/** PRINT_LIMIT_REACHED (ADR 0031): prints allowed per device on the share, and already used. */
export const printLimitReachedDetailsSchema = z.object({
  limit: z.number().int().positive(),
  used: z.number().int().nonnegative(),
});
export type PrintLimitReachedDetails = z.output<typeof printLimitReachedDetailsSchema>;

/** Schema of `details` for the codes that have them. */
export const ERROR_DETAILS_SCHEMAS = {
  VALIDATION_FAILED: validationFailedDetailsSchema,
  QUOTA_EXCEEDED: quotaExceededDetailsSchema,
  FILE_TOO_LARGE: fileTooLargeDetailsSchema,
  UNSUPPORTED_FILE_TYPE: unsupportedFileTypeDetailsSchema,
  NAME_TAKEN: nameTakenDetailsSchema,
  FOLDER_DEPTH_EXCEEDED: folderDepthExceededDetailsSchema,
  SUBSCRIPTION_INACTIVE: subscriptionInactiveDetailsSchema,
  SHARE_EXPIRED: shareExpiredDetailsSchema,
  CONSENT_REQUIRED: consentVersionDetailsSchema,
  CONSENT_VERSION_MISMATCH: consentVersionDetailsSchema,
  NO_FACE_DETECTED: noFaceDetectedDetailsSchema,
  ZIP_TOO_LARGE: zipTooLargeDetailsSchema,
  FEATURE_DISABLED: featureDisabledDetailsSchema,
  FACE_SEARCH_UNAVAILABLE: faceSearchUnavailableDetailsSchema,
  PLAN_CHANGE_INVALID: planChangeInvalidDetailsSchema,
  CHECKOUT_PENDING: checkoutPendingDetailsSchema,
  AUTH_PROVIDER_UNAVAILABLE: authProviderUnavailableDetailsSchema,
  IDENTITY_PROVIDER_ERROR: identityProviderErrorDetailsSchema,
  PASSWORD_TOO_WEAK: passwordTooWeakDetailsSchema,
  COVER_FILE_INVALID: coverFileInvalidDetailsSchema,
  DESIGN_REVISION_CONFLICT: designRevisionConflictDetailsSchema,
  DESIGN_ASSET_NOT_FOUND: designAssetNotFoundDetailsSchema,
  DESIGN_LIMIT_REACHED: designLimitReachedDetailsSchema,
  DESIGN_DOC_TOO_LARGE: designDocTooLargeDetailsSchema,
  PLAN_EXPIRED: planExpiredDetailsSchema,
  PHOTO_LIMIT_REACHED: photoLimitReachedDetailsSchema,
  PRINT_LIMIT_REACHED: printLimitReachedDetailsSchema,
} as const satisfies Partial<Record<ErrorCode, z.ZodType>>;

/**
 * Where a request part failed validation: `params`, `query`, `body`, or `headers` (e.g. a
 * missing or malformed `Idempotency-Key`; header names are lowercase in paths).
 */
export type RequestPart = 'params' | 'query' | 'body' | 'headers';

/**
 * VALIDATION_FAILED details from a zod error, with paths prefixed by the request part. Uses only
 * zod's messages and paths, never the input values.
 */
export function validationFailedDetails(
  part: RequestPart,
  error: z.ZodError,
): ValidationFailedDetails {
  return {
    issues: error.issues.map((issue) => ({
      path: [part, ...issue.path.map((p) => (typeof p === 'number' ? p : String(p)))],
      message: issue.message,
    })),
  };
}
