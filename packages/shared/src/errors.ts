import { z } from 'zod';
import { FEATURES, SHARE_UNAVAILABLE_REASONS, SUBSCRIPTION_STATUSES } from './domain';

/** Stable API error codes. The web app maps each code to a Thai message. */
export const ErrorCode = {
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  SHARE_EXPIRED: 'SHARE_EXPIRED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  NO_FACE_DETECTED: 'NO_FACE_DETECTED',
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
  /** No valid token, or the token is from the wrong Cognito pool for this route. */
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
  /** POST /s/:token/unlock with the wrong password. */
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
   * The feature is switched off by configuration (FACE_SEARCH_ENABLED=false): consent, face
   * search, face deletion, feedback and enabling face indexing. Details: FeatureDisabledDetails.
   */
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  /**
   * Face search is on, but not for this share: it isn't a folder share, or no folder in it has an
   * active face index. Details: FaceSearchUnavailableDetails.
   */
  FACE_SEARCH_UNAVAILABLE: 'FACE_SEARCH_UNAVAILABLE',
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
