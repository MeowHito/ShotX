/** Stable API error codes. The web app maps each code to a Thai message. */
export const ErrorCode = {
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  SHARE_EXPIRED: 'SHARE_EXPIRED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  NO_FACE_DETECTED: 'NO_FACE_DETECTED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Body of every API error response. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
