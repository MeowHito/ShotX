import { z } from 'zod';
import { SUBSCRIPTION_STATUSES } from './domain';

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

/** Schema of `details` for the codes that have them. */
export const ERROR_DETAILS_SCHEMAS = {
  VALIDATION_FAILED: validationFailedDetailsSchema,
  QUOTA_EXCEEDED: quotaExceededDetailsSchema,
  FILE_TOO_LARGE: fileTooLargeDetailsSchema,
  UNSUPPORTED_FILE_TYPE: unsupportedFileTypeDetailsSchema,
  NAME_TAKEN: nameTakenDetailsSchema,
  FOLDER_DEPTH_EXCEEDED: folderDepthExceededDetailsSchema,
  SUBSCRIPTION_INACTIVE: subscriptionInactiveDetailsSchema,
} as const satisfies Partial<Record<ErrorCode, z.ZodType>>;

/** Where a request part failed validation: `params`, `query` or `body`. */
export type RequestPart = 'params' | 'query' | 'body';

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
