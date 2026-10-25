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
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Body of every API error response. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
